// @flow

import HTTP, {type HTTPError, type HTTPRequestOptions} from 'http-call'
import yubikey from './yubikey'
import Mutex from './mutex'
import Vars from './vars'
import {URL} from 'url'
import type {Config} from 'cli-engine-config'
import type {CLI} from 'cli-ux'

type Options = {
  required?: boolean,
  preauth?: boolean
}

type HerokuAPIErrorOptions = $Shape<{
  resource: ?string,
  app: ?{id: ?string, name: ?string},
  id: ?string,
  message: ?string,
  url: ?string
}>

export class HerokuAPIError extends Error {
  http: HTTPError
  body: HerokuAPIErrorOptions

  constructor (httpError: HTTPError) {
    let options: HerokuAPIErrorOptions = httpError.body
    if (!options.message) throw httpError
    let info = []
    if (options.id) info.push(`Error ID: ${options.id}`)
    if (options.app && options.app.name) info.push(`App: ${options.app.name}`)
    if (options.url) info.push(`See ${options.url} for more information.`)
    if (info.length) super([options.message, ''].concat(info).join('\n'))
    else super(options.message)
    this.http = httpError
    this.body = options
  }
}

export default class Heroku {
  options: Options
  twoFactorMutex: Mutex
  preauthPromises: {[k: string]: Promise<*>}
  http: Class<HTTP>
  config: Config
  cli: CLI

  constructor ({config, cli}: {config: Config, cli?: CLI} = {}, options: Options = {}) {
    this.config = config
    const {CLI} = require('cli-ux')
    this.cli = cli || new CLI({mock: config.mock})
    if (options.required === undefined) options.required = true
    options.preauth = options.preauth !== false
    this.options = options
    let apiUrl = new URL(Vars.apiUrl)
    let envHeaders = JSON.parse(process.env.HEROKU_HEADERS || '{}')
    this.twoFactorMutex = new Mutex()
    this.preauthPromises = {}
    let auth = this.auth
    let self = this
    this.http = class extends HTTP {
      static get defaultOptions () {
        let opts = {
          ...super.defaultOptions,
          host: apiUrl.host,
          headers: {
            ...super.defaultOptions.headers,
            'user-agent': `heroku-cli/${self.config.version} ${self.config.platform}`,
            accept: 'application/vnd.heroku+json; version=3',
            ...envHeaders
          }
        }
        if (auth) opts.headers.authorization = `Bearer ${auth}`
        return opts
      }

      static async twoFactorRetry (err, url, opts = {}, retries = 3) {
        const app = err.body.app ? err.body.app.name : null
        if (!app || !options.preauth) {
          // flow$ignore
          opts.headers['Heroku-Two-Factor-Code'] = await self.twoFactorPrompt()
          return this.request(url, opts, retries)
        } else {
          // if multiple requests are run in parallel for the same app, we should
          // only preauth for the first so save the fact we already preauthed
          if (!self.preauthPromises[app]) {
            self.preauthPromises[app] = self.twoFactorPrompt().then(factor => self.preauth(app, factor))
          }

          await self.preauthPromises[app]
          return this.request(url, opts, retries)
        }
      }

      static async request (url, opts, retries = 3) {
        retries--
        try {
          return await super.request(url, opts)
        } catch (err) {
          if (!err.__httpcall) throw err
          let apiError = new HerokuAPIError(err)
          if (retries > 0) {
            if (apiError.http.statusCode === 403 && apiError.body.id === 'two_factor') {
              return this.twoFactorRetry(apiError, url, opts, retries)
            }
          }
          throw apiError
        }
      }
    }
  }

  get auth (): ?string {
    let auth = process.env.HEROKU_API_KEY
    if (!auth) {
      const Netrc = require('netrc-parser')
      const netrc = new Netrc()
      auth = netrc.machines[Vars.apiHost].password
    }
    // TODO: handle required
    return auth
  }

  twoFactorPrompt () {
    yubikey.enable()
    return this.twoFactorMutex.synchronize(async () => {
      try {
        let factor = await this.cli.prompt('Two-factor code', {type: 'mask'})
        yubikey.disable()
        return factor
      } catch (err) {
        yubikey.disable()
        throw err
      }
    })
  }

  preauth (app: string, factor: string) {
    return this.put(`/apps/${app}/pre-authorizations`, {
      headers: { 'Heroku-Two-Factor-Code': factor }
    })
  }
  get (url: string, options: HTTPRequestOptions = {}) {
    return this.http.get(url, options)
  }
  post (url: string, options: HTTPRequestOptions = {}) {
    return this.http.post(url, options)
  }
  put (url: string, options: HTTPRequestOptions = {}) {
    return this.http.put(url, options)
  }
  patch (url: string, options: HTTPRequestOptions = {}) {
    return this.http.patch(url, options)
  }
  delete (url: string, options: HTTPRequestOptions = {}) {
    return this.http.delete(url, options)
  }
  stream (url: string, options: HTTPRequestOptions = {}) {
    return this.http.stream(url, options)
  }
  request (url: string, options: HTTPRequestOptions = {}) {
    return this.http.request(url, options)
  }
  get defaultOptions (): HTTPRequestOptions {
    return this.http.defaultOptions
  }
}
