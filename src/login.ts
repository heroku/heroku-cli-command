import type {KeyDescriptor} from 'inquirer-press-to-continue'

import HTTP from '@heroku/http-call'
import color from '@heroku-cli/color'
import * as Heroku from '@heroku-cli/schema'
import {Interfaces, ux} from '@oclif/core'
import inquirer, {QuestionCollection} from 'inquirer'
import PressToContinuePrompt from 'inquirer-press-to-continue'
import Netrc from 'netrc-parser'
import open from 'open'
import * as os from 'os'

import {APIClient, HerokuAPIError} from './api-client'
import {vars} from './vars'

const debug = require('debug')('heroku-cli-command')
const hostname = os.hostname()
const thirtyDays = 60 * 60 * 24 * 30
inquirer.registerPrompt('press-to-continue', PressToContinuePrompt)

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Login {
  export interface Options {
    browser?: string
    expiresIn?: number
    method?: 'browser' | 'interactive' | 'sso'
  }
}

interface NetrcEntry {
  login: string
  password: string
}

const headers = (token: string) => ({headers: {accept: 'application/vnd.heroku+json; version=3', authorization: `Bearer ${token}`}})

export class Login {
  loginHost = process.env.HEROKU_LOGIN_HOST || 'https://cli-auth.heroku.com'

  constructor(private readonly config: Interfaces.Config, private readonly heroku: APIClient) {}

  async login(opts: Login.Options = {}): Promise<void> {
    let loggedIn = false
    try {
      // timeout after 10 minutes
      setTimeout(() => {
        if (!loggedIn) ux.error('timed out')
      }, 1000 * 60 * 10).unref()

      if (process.env.HEROKU_API_KEY) ux.error('Cannot log in with HEROKU_API_KEY set')
      if (opts.expiresIn && opts.expiresIn > thirtyDays) ux.error('Cannot set an expiration longer than thirty days')

      await Netrc.load()
      const previousEntry = Netrc.machines['api.heroku.com']
      let input: string | undefined = opts.method
      if (!input) {
        if (opts.expiresIn) {
          // can't use browser with --expires-in
          input = 'interactive'
        } else if (process.env.HEROKU_LEGACY_SSO === '1') {
          input = 'sso'
        } else {
          await inquirer.prompt<{ key: KeyDescriptor }>({
            anyKey: true,
            name: 'key',
            pressToContinueMessage: 'heroku: Press any key to open up the browser to login or q to exit',
            type: 'press-to-continue',
          })
          input = 'browser'
        }
      }

      try {
        if (previousEntry && previousEntry.password) await this.logout(previousEntry.password)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ux.warn(message)
      }

      let auth
      switch (input) {
      case 'b':
      case 'browser': {
        auth = await this.browser(opts.browser)
        break
      }

      case 'i':
      case 'interactive': {
        auth = await this.interactive(previousEntry && previousEntry.login, opts.expiresIn)
        break
      }

      case 's':
      case 'sso': {
        auth = await this.sso()
        break
      }

      default: {
        return this.login(opts)
      }
      }

      await this.saveToken(auth)
    } catch (error: any) {
      throw new HerokuAPIError(error)
    } finally {
      loggedIn = true
    }
  }

  async logout(token = this.heroku.auth) {
    if (!token) return debug('no credentials to logout')
    const requests: Promise<any>[] = []
    // for SSO logins we delete the session since those do not show up in
    // authorizations because they are created a trusted client
    requests.push(HTTP.delete(`${vars.apiUrl}/oauth/sessions/~`, headers(token))
      .catch(error => {
        if (!error.http) throw error
        if (error.http.statusCode === 404 && error.http.body && error.http.body.id === 'not_found' && error.http.body.resource === 'session') {
          return
        }

        if (error.http.statusCode === 401 && error.http.body && error.http.body.id === 'unauthorized') {
          return
        }

        throw error
      }))

    // grab all the authorizations so that we can delete the token they are
    // using in the CLI.  we have to do this rather than delete ~ because
    // the ~ is the API Key, not the authorization that is currently requesting
    requests.push(HTTP.get<Heroku.OAuthAuthorization[]>(`${vars.apiUrl}/oauth/authorizations`, headers(token))
      .then(async ({body: authorizations}) => {
      // grab the default authorization because that is the token shown in the
      // dashboard as API Key and they may be using it for something else and we
      // would unwittingly break an integration that they are depending on
        const d = await this.defaultToken()
        if (d === token) return
        return Promise.all(
          authorizations
            .filter(a => a.access_token && a.access_token.token === this.heroku.auth)
            .map(a => HTTP.delete(`${vars.apiUrl}/oauth/authorizations/${a.id}`, headers(token))),
        )
      })
      .catch(error => {
        if (!error.http) throw error
        if (error.http.statusCode === 401 && error.http.body && error.http.body.id === 'unauthorized') {
          return []
        }

        throw error
      }))

    await Promise.all(requests)
  }

  private async browser(browser?: string): Promise<NetrcEntry> {
    const {body: urls} = await HTTP.post<{browser_url: string, cli_url: string, token: string}>(`${this.loginHost}/auth`, {
      body: {description: `Heroku CLI login from ${hostname}`},
    })
    const url = `${this.loginHost}${urls.browser_url}`
    ux.stderr(`Opening browser to ${url}\n`)
    let urlDisplayed = false
    const showUrl = () => {
      if (!urlDisplayed) ux.warn('Cannot open browser.')
      urlDisplayed = true
    }

    // ux.warn(`If browser does not open, visit ${color.greenBright(url)}`)
    const cp = await open(url, {wait: false, ...(browser ? {app: {name: browser}} : {})})
    cp.on('error', err => {
      ux.warn(err)
      showUrl()
    })
    if (process.env.HEROKU_TESTING_HEADLESS_LOGIN === '1') showUrl()
    cp.on('close', code => {
      if (code !== 0) showUrl()
    })
    ux.action.start('heroku: Waiting for login')
    const fetchAuth = async (retries = 3): Promise<{access_token: string, error?: string}> => {
      try {
        const {body: auth} = await HTTP.get<{access_token: string, error?: string}>(`${this.loginHost}${urls.cli_url}`, {
          headers: {authorization: `Bearer ${urls.token}`},
        })
        return auth
      } catch (error: any) {
        if (retries > 0 && error.http && error.http.statusCode > 500) return fetchAuth(retries - 1)
        throw error
      }
    }

    const auth = await fetchAuth()
    if (auth.error) ux.error(auth.error)
    this.heroku.auth = auth.access_token
    ux.action.start('Logging in')
    const {body: account} = await HTTP.get<Heroku.Account>(`${vars.apiUrl}/account`, headers(auth.access_token))
    ux.action.stop()
    return {
      login: account.email!,
      password: auth.access_token,
    }
  }

  private async createOAuthToken(username: string, password: string, opts: {expiresIn?: number, secondFactor?: string} = {}): Promise<NetrcEntry> {
    function basicAuth(username: string, password: string) {
      let auth = [username, password].join(':')
      auth = Buffer.from(auth).toString('base64')
      return `Basic ${auth}`
    }

    const headers: {[k: string]: string} = {
      accept: 'application/vnd.heroku+json; version=3',
      authorization: basicAuth(username, password),
    }

    if (opts.secondFactor) headers['Heroku-Two-Factor-Code'] = opts.secondFactor

    const {body: auth} = await HTTP.post<Heroku.OAuthAuthorization>(`${vars.apiUrl}/oauth/authorizations`, {
      body: {
        description: `Heroku CLI login from ${hostname}`,
        expires_in: opts.expiresIn || thirtyDays,
        scope: ['global'],
      },
      headers,
    })
    return {login: auth.user!.email!, password: auth.access_token!.token!}
  }

  private async defaultToken(): Promise<string | undefined> {
    try {
      const {body: authorization} = await HTTP.get<Heroku.OAuthAuthorization>(`${vars.apiUrl}/oauth/authorizations/~`, headers(this.heroku.auth!))
      return authorization.access_token && authorization.access_token.token
    } catch (error: any) {
      if (!error.http) throw error
      if (error.http.statusCode === 404 && error.http.body && error.http.body.id === 'not_found' && error.body.resource === 'authorization') return
      if (error.http.statusCode === 401 && error.http.body && error.http.body.id === 'unauthorized') return
      throw error
    }
  }

  private async interactive(login?: string, expiresIn?: number): Promise<NetrcEntry> {
    ux.stderr('heroku: Enter your login credentials\n')
    const emailQuestions: QuestionCollection = [{
      default: login,
      message: 'Email',
      name: 'email',
      type: 'input',
    }]
    const {email} = await inquirer.prompt<{email: string}>(emailQuestions)
    login = email

    const passwordQuestions: QuestionCollection = [{
      message: 'Password',
      name: 'password',
      type: 'password',
    }]
    const {password} = await inquirer.prompt<{password: string}>(passwordQuestions)

    let auth
    try {
      auth = await this.createOAuthToken(login!, password, {expiresIn})
    } catch (error: any) {
      if (error.body && error.body.id === 'device_trust_required') {
        error.body.message = 'The interactive flag requires Two-Factor Authentication to be enabled on your account. Please use heroku login.'
        throw error
      }

      if (!error.body || error.body.id !== 'two_factor') {
        throw error
      }

      const secondFactorQuestions: QuestionCollection = [{
        message: 'Two-factor code',
        name: 'secondFactor',
        type: 'password',
      }]
      const {secondFactor} = await inquirer.prompt<{secondFactor: string}>(secondFactorQuestions)
      auth = await this.createOAuthToken(login!, password, {expiresIn, secondFactor})
    }

    this.heroku.auth = auth.password
    return auth
  }

  private async saveToken(entry: NetrcEntry) {
    const hosts = [vars.apiHost, vars.httpGitHost]
    hosts.forEach(host => {
      if (!Netrc.machines[host]) Netrc.machines[host] = {}
      Netrc.machines[host].login = entry.login
      Netrc.machines[host].password = entry.password
      delete Netrc.machines[host].method
      delete Netrc.machines[host].org
    })

    if (Netrc.machines._tokens) {
      (Netrc.machines._tokens as any).forEach((token: any) => {
        if (hosts.includes(token.host)) {
          token.internalWhitespace = '\n  '
        }
      })
    }

    await Netrc.save()
  }

  private async sso(): Promise<NetrcEntry> {
    let url = process.env.SSO_URL
    let org = process.env.HEROKU_ORGANIZATION
    if (!url) {
      const orgQuestions: QuestionCollection = [{
        default: org,
        message: 'Organization name',
        name: 'orgName',
        type: 'input',
      }]
      const {orgName} = await inquirer.prompt<{orgName: string}>(orgQuestions)
      org = orgName
      url = `https://sso.heroku.com/saml/${encodeURIComponent(org!)}/init?cli=true`
    }

    // TODO: handle browser
    debug(`opening browser to ${url}`)
    ux.stderr(`Opening browser to:\n${url}\n`)
    ux.stderr(color.gray(
      'If the browser fails to open or you\'re authenticating on a '
      + 'remote machine, please manually open the URL above in your '
      + 'browser.\n',
    ))
    await open(url, {wait: false})

    const passwordQuestions: QuestionCollection = [{
      message: 'Access token',
      name: 'password',
      type: 'password',
    }]
    const {password} = await inquirer.prompt<{password: string}>(passwordQuestions)
    ux.action.start('Validating token')
    this.heroku.auth = password
    const {body: account} = await HTTP.get<Heroku.Account>(`${vars.apiUrl}/account`, headers(password))
    ux.action.stop()
    return {
      login: account.email!,
      password,
    }
  }
}
