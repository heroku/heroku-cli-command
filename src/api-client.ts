import {Interfaces} from '@oclif/core'
import {CLIError, warn} from '@oclif/core/lib/errors'
import {HTTP, HTTPError, HTTPRequestOptions} from 'http-call'
import Netrc from 'netrc-parser'
import * as url from 'node:url'

import deps from './deps'
import {Login} from './login'
import {Mutex} from './mutex'
import {RequestId, requestIdHeader} from './request-id'
import {vars} from './vars'

export namespace APIClient {
  export interface Options extends HTTPRequestOptions {
    retryAuth?: boolean
  }
}

export interface IOptions {
  required?: boolean
  preauth?: boolean
}

export interface IHerokuAPIErrorOptions {
  resource?: string
  app?: { id: string; name: string }
  id?: string
  message?: string
  url?: string
}

export class HerokuAPIError extends CLIError {
  http: HTTPError
  body: IHerokuAPIErrorOptions

  constructor(httpError: HTTPError) {
    if (!httpError) throw new Error('invalid error')
    const options: IHerokuAPIErrorOptions = httpError.body
    if (!options || !options.message) throw httpError
    const info = []
    if (options.id) info.push(`Error ID: ${options.id}`)
    if (options.app && options.app.name) info.push(`App: ${options.app.name}`)
    if (options.url) info.push(`See ${options.url} for more information.`)
    if (info.length > 0) super([options.message, '', ...info].join('\n'))
    else super(options.message)
    this.http = httpError
    this.body = options
  }
}

export class APIClient {
  preauthPromises: { [k: string]: Promise<HTTP<any>> }
  authPromise?: Promise<HTTP<any>>
  http: typeof HTTP
  private readonly _login = new Login(this.config, this)
  private _twoFactorMutex: Mutex<string> | undefined
  private _auth?: string

  constructor(protected config: Interfaces.Config, public options: IOptions = {}) {
    this.config = config
    if (options.required === undefined) options.required = true
    options.preauth = options.preauth !== false
    this.options = options
    const apiUrl = url.URL ? new url.URL(vars.apiUrl) : url.parse(vars.apiUrl)
    const envHeaders = JSON.parse(process.env.HEROKU_HEADERS || '{}')
    this.preauthPromises = {}
    const self = this as any
    const opts = {
      host: apiUrl.hostname,
      port: apiUrl.port,
      protocol: apiUrl.protocol,
      headers: {
        accept: 'application/vnd.heroku+json; version=3',
        'user-agent': `heroku-cli/${self.config.version} ${self.config.platform}`,
        ...envHeaders,
      },
    }
    this.http = class APIHTTPClient<T> extends deps.HTTP.HTTP.create(opts)<T> {
      static async twoFactorRetry(
        err: HTTPError,
        url: string,
        opts: APIClient.Options = {},
        retries = 3,
      ): Promise<APIHTTPClient<any>> {
        const app = err.body.app ? err.body.app.name : null
        if (!app || !options.preauth) {
          opts.headers = opts.headers || {}
          opts.headers['Heroku-Two-Factor-Code'] = await self.twoFactorPrompt()
          return this.request(url, opts, retries)
        }

        // if multiple requests are run in parallel for the same app, we should
        // only preauth for the first so save the fact we already preauthed
        if (!self.preauthPromises[app]) {
          self.preauthPromises[app] = self.twoFactorPrompt().then((factor: any) => self.preauth(app, factor))
        }

        await self.preauthPromises[app]
        return this.request(url, opts, retries)
      }

      static trackRequestIds<T>(response: HTTP<T>) {
        const responseRequestIdHeader = response.headers[requestIdHeader]
        if (responseRequestIdHeader) {
          const requestIds = Array.isArray(responseRequestIdHeader) ? responseRequestIdHeader : responseRequestIdHeader.split(',')
          RequestId.track(...requestIds)
        }
      }

      static async request<T>(url: string, opts: APIClient.Options = {}, retries = 3): Promise<APIHTTPClient<T>> {
        opts.headers = opts.headers || {}
        opts.headers[requestIdHeader] = RequestId.create() && RequestId.headerValue

        if (!Object.keys(opts.headers).find(h => h.toLowerCase() === 'authorization')) {
          opts.headers.authorization = `Bearer ${self.auth}`
        }

        retries--
        try {
          const response = await super.request<T>(url, opts)
          this.trackRequestIds<T>(response)
          return response
        } catch (error) {
          if (!(error instanceof deps.HTTP.HTTPError)) throw error
          if (retries > 0) {
            if (opts.retryAuth !== false && error.http.statusCode === 401 && error.body.id === 'unauthorized') {
              if (process.env.HEROKU_API_KEY) {
                throw new Error('The token provided to HEROKU_API_KEY is invalid. Please double-check that you have the correct token, or run `heroku login` without HEROKU_API_KEY set.')
              }

              if (!self.authPromise) self.authPromise = self.login()
              await self.authPromise
              opts.headers.authorization = `Bearer ${self.auth}`
              return this.request<T>(url, opts, retries)
            }

            if (error.http.statusCode === 403 && error.body.id === 'two_factor') {
              return this.twoFactorRetry(error, url, opts, retries)
            }
          }

          throw new HerokuAPIError(error)
        }
      }
    }
  }

  get twoFactorMutex(): Mutex<string> {
    if (!this._twoFactorMutex) {
      this._twoFactorMutex = new deps.Mutex()
    }

    return this._twoFactorMutex
  }

  get auth(): string | undefined {
    if (!this._auth) {
      if (process.env.HEROKU_API_TOKEN && !process.env.HEROKU_API_KEY) deps.cli.warn('HEROKU_API_TOKEN is set but you probably meant HEROKU_API_KEY')
      this._auth = process.env.HEROKU_API_KEY
      if (!this._auth) {
        deps.netrc.loadSync()
        this._auth = deps.netrc.machines[vars.apiHost] && deps.netrc.machines[vars.apiHost].password
      }
    }

    return this._auth
  }

  set auth(token: string | undefined) {
    delete this.authPromise
    this._auth = token
  }

  twoFactorPrompt() {
    deps.yubikey.enable()
    return this.twoFactorMutex.synchronize(async () => {
      try {
        const factor = await deps.cli.prompt('Two-factor code', {type: 'mask'})
        deps.yubikey.disable()
        return factor
      } catch (error) {
        deps.yubikey.disable()
        throw error
      }
    })
  }

  preauth(app: string, factor: string) {
    return this.put(`/apps/${app}/pre-authorizations`, {
      headers: {'Heroku-Two-Factor-Code': factor},
    })
  }

  get<T>(url: string, options: APIClient.Options = {}) {
    return this.http.get<T>(url, options)
  }

  post<T>(url: string, options: APIClient.Options = {}) {
    return this.http.post<T>(url, options)
  }

  put<T>(url: string, options: APIClient.Options = {}) {
    return this.http.put<T>(url, options)
  }

  patch<T>(url: string, options: APIClient.Options = {}) {
    return this.http.patch<T>(url, options)
  }

  delete<T>(url: string, options: APIClient.Options = {}) {
    return this.http.delete<T>(url, options)
  }

  stream(url: string, options: APIClient.Options = {}) {
    return this.http.stream(url, options)
  }

  request<T>(url: string, options: APIClient.Options = {}) {
    return this.http.request<T>(url, options)
  }

  login(opts: Login.Options = {}) {
    return this._login.login(opts)
  }

  async logout() {
    try {
      await this._login.logout()
    } catch (error) {
      if (error instanceof CLIError) warn(error)
    }

    delete Netrc.machines['api.heroku.com']
    delete Netrc.machines['git.heroku.com']
    await Netrc.save()
  }

  get defaults(): typeof HTTP.defaults {
    return this.http.defaults
  }
}
