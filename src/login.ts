import color from '@heroku-cli/color'
import * as Config from '@oclif/config'
import ux from 'cli-ux'
import HTTP from 'http-call'
import Netrc from 'netrc-parser'
import opn = require('opn')
import {hostname} from 'os'

import {APIClient, HerokuAPIError} from './api_client'
import {vars} from './vars'

const debug = require('debug')('heroku-cli-command')

export namespace Login {
  export interface Options {
    expiresIn?: number
    method?: 'interactive' | 'sso' | 'browser'
    browser?: string
  }
}

interface NetrcEntry {
  login: string
  password: string
  method?: 'interactive' | 'sso' | 'browser'
  org?: string
  refresh?: string
}

interface Authorization {
  id: string
  access_token?: {
    token: string
  }
}

const headers = (token: string) => ({headers: {accept: 'application/vnd.heroku+json; version=3', authorization: `Bearer ${token}`}})

export class Login {
  loginHost = process.env.HEROKU_LOGIN_HOST || 'https://cli-login.heroku.com'

  constructor(private readonly config: Config.IConfig, private readonly heroku: APIClient) {}

  async login(opts: Login.Options = {}): Promise<void> {
    let loggedIn = false
    try {
      // timeout after 10 minutes
      setTimeout(() => {
        if (!loggedIn) ux.error('timed out')
      }, 1000 * 60 * 10).unref()

      if (process.env.HEROKU_API_KEY) ux.error('Cannot log in with HEROKU_API_KEY set')
      await Netrc.load()
      const previousEntry = Netrc.machines['api.heroku.com']
      let input: string | undefined = opts.method
      const defaultMethod = (previousEntry && previousEntry.method) || 'interactive'
      if (!input) {
        if (opts.expiresIn) {
          // can't use browser with --expires-in
          input = 'interactive'
        } else if (this.enableBrowserLogin()) {
          input = await ux.prompt(`heroku: Login with [${color.green('b')}]rowser, [${color.green('i')}]nteractive, or [${color.green('s')}]so (enterprise-only)`, {default: defaultMethod})
        } else {
          input = defaultMethod || 'interactive'
        }
      }
      let auth
      const logout = async () => {
        if (previousEntry && previousEntry.password) {
          try {
            await this.logout(previousEntry.password)
            delete previousEntry.password
          } catch (err) {
            ux.warn(err)
          }
        }
      }
      switch (input) {
        case 'b':
        case 'browser':
          auth = await this.browser()
          break
        case 'i':
        case 'interactive':
          auth = await this.interactive(previousEntry && previousEntry.login, opts.expiresIn)
          break
        case 's':
        case 'sso':
          await logout() // for sso logout first
          auth = await this.sso(previousEntry && previousEntry.org)
          break
        default:
          return this.login(opts)
      }
      await this.saveToken(auth)
      await logout()
    } catch (err) {
      throw new HerokuAPIError(err)
    } finally {
      loggedIn = true
    }
  }

  async logout(token = this.heroku.auth) {
    if (!token) return debug('no credentials to logout')
    const requests: Promise<any>[] = []
    // for SSO logins we delete the session since those do not show up in
    // authorizations because they are created a trusted client
    requests.push(HTTP.delete(`${vars.apiUrl}/oauth/sessions/~`, headers(this.heroku.auth!))
    .catch(err => {
      if (!err.http) throw err
      if (err.http.statusCode === 404 && err.http.body && err.http.body.id === 'not_found' && err.http.body.resource === 'session') {
        return
      }
      if (err.http.statusCode === 401 && err.http.body && err.http.body.id === 'unauthorized') {
        return
      }
      throw err
    }))

    // grab all the authorizations so that we can delete the token they are
    // using in the CLI.  we have to do this rather than delete ~ because
    // the ~ is the API Key, not the authorization that is currently requesting
    requests.push(HTTP.get(`${vars.apiUrl}/oauth/authorizations`, headers(this.heroku.auth!))
    .then(async ({body: authorizations}: {body: Authorization[]}) => {
      // grab the default authorization because that is the token shown in the
      // dashboard as API Key and they may be using it for something else and we
      // would unwittingly break an integration that they are depending on
      const d = await this.defaultToken()
      if (d === token) return
      return Promise.all(
        authorizations
        .filter(a => a.access_token && a.access_token.token !== this.heroku.auth)
        .map(a => HTTP.delete(`${vars.apiUrl}/oauth/authorizations/${a.id}`, headers(this.heroku.auth!)))
      )
    })
    .catch(err => {
      if (!err.http) throw err
      if (err.http.statusCode === 401 && err.http.body && err.http.body.id === 'unauthorized') {
        return []
      }
      throw err
    }))

    await Promise.all(requests)
  }

  private async browser(): Promise<NetrcEntry> {
    const {body: urls} = await HTTP.post(`${this.loginHost}/auth`)
    // TODO: handle browser
    await opn(`${this.loginHost}${urls.browser_url}`, {wait: false})
    ux.action.start('Waiting for login')
    const {body: auth} = await HTTP.get(`${this.loginHost}${urls.cli_url}`, {
      headers: {
        authorization: `Bearer ${urls.token}`,
      }
    })
    if (auth.error) ux.error(auth.error)
    this.heroku.auth = auth.access_token
    ux.action.start('Logging in')
    const {body: account} = await HTTP.get(`${vars.apiUrl}/account`, headers(auth.access_token))
    ux.action.stop()
    return {
      login: account.email,
      password: auth.access_token,
      refresh: auth.refresh_token,
      method: 'browser',
    }
  }

  private async interactive(login?: string, expiresIn?: number): Promise<NetrcEntry> {
    process.stderr.write('heroku: Enter your login credentials\n')
    login = await ux.prompt('Email', {default: login})
    let password = await ux.prompt('Password', {type: 'hide'})

    let auth
    try {
      auth = await this.createOAuthToken(login!, password, {expiresIn})
    } catch (err) {
      if (!err.body || err.body.id !== 'two_factor') throw err
      let secondFactor = await ux.prompt('Two-factor code', {type: 'mask'})
      auth = await this.createOAuthToken(login!, password, {expiresIn, secondFactor})
    }
    this.heroku.auth = auth.password
    auth.method = 'interactive'
    return auth
  }

  private async createOAuthToken(username: string, password: string, opts: {expiresIn?: number, secondFactor?: string} = {}): Promise<NetrcEntry> {
    function basicAuth(username: string, password: string) {
      let auth = [username, password].join(':')
      auth = Buffer.from(auth).toString('base64')
      return `Basic ${auth}`
    }

    let headers: {[k: string]: string} = {
      accept: 'application/vnd.heroku+json; version=3',
      authorization: basicAuth(username, password)
    }

    if (opts.secondFactor) headers['Heroku-Two-Factor-Code'] = opts.secondFactor

    const {body: auth} = await HTTP.post(`${vars.apiUrl}/oauth/authorizations`, {
      headers,
      body: {
        scope: ['global'],
        description: `Heroku CLI login from ${hostname()}`,
        expires_in: opts.expiresIn || 60 * 60 * 24 * 365 // 1 year
      }
    })
    return {password: auth.access_token.token, login: auth.user.email}
  }

  private async saveToken(entry: NetrcEntry) {
    const hosts = [vars.apiHost, vars.httpGitHost]
    hosts.forEach(host => {
      if (!Netrc.machines[host]) Netrc.machines[host] = {}
      Netrc.machines[host].login = entry.login
      Netrc.machines[host].password = entry.password
    })
    Netrc.machines[vars.apiHost].refresh = entry.refresh
    Netrc.machines[vars.apiHost].method = entry.method
    Netrc.machines[vars.apiHost].org = entry.org
    if (Netrc.machines._tokens) {
      (Netrc.machines._tokens as any).forEach((token: any) => {
        if (hosts.includes(token.host)) {
          token.internalWhitespace = '\n  '
        }
      })
    }
    await Netrc.save()
  }

  private async defaultToken(): Promise<string | undefined> {
    try {
      const {body: authorization}: {body: Authorization} = await HTTP.get(`${vars.apiUrl}/oauth/authorizations/~`, headers(this.heroku.auth!))
      return authorization.access_token && authorization.access_token.token
    } catch (err) {
      if (!err.http) throw err
      if (err.http.statusCode === 404 && err.http.body && err.http.body.id === 'not_found' && err.body.resource === 'authorization') return
      if (err.http.statusCode === 401 && err.http.body && err.http.body.id === 'unauthorized') return
      throw err
    }
  }

  private enableBrowserLogin() {
    if (!process.env.HEROKU_LOGIN_HOST) return false
    if (this.config.name === '@heroku-cli/command') return true
    return this.config.channel !== 'stable'
  }

  private async sso(org?: string): Promise<NetrcEntry> {
    let url = process.env.SSO_URL
    if (!url) {
      org = process.env.HEROKU_ORGANIZATION || org
      if (org) {
        org = await ux.prompt('Organization name', {default: org})
      } else {
        org = await ux.prompt('Organization name')
      }
      url = `https://sso.heroku.com/saml/${encodeURIComponent(org!)}/init?cli=true`
    }

    ux.action.start('Opening browser for login')
    // TODO: handle browser
    await opn(url, {wait: false})

    const password = await ux.prompt('Access token', {type: 'mask'})
    ux.action.start('Validating token')
    this.heroku.auth = password
    const {body: account} = await HTTP.get(`${vars.apiUrl}/account`, headers(password))

    return {password, login: account.email, method: 'sso', org}
  }
}
