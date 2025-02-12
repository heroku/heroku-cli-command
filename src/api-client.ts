import {Interfaces} from '@oclif/core'
import {CLIError, warn} from '@oclif/core/lib/errors'
import {HTTP, HTTPError, HTTPRequestOptions} from '@heroku/http-call'
import Netrc from 'netrc-parser'
import * as url from 'url'

import deps from './deps'
import {Login} from './login'
import {Mutex} from './mutex'
import {RequestId, requestIdHeader} from './request-id'
import {vars} from './vars'
import {ParticleboardClient, IDelinquencyInfo, IDelinquencyConfig} from './particleboard-client'

const debug = require('debug')

export namespace APIClient {
  export interface Options extends HTTPRequestOptions {
    retryAuth?: boolean
  }
}

export interface IOptions {
  required?: boolean
  preauth?: boolean
  debug?: boolean
  debugHeaders?: boolean
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
  private _particleboard!: ParticleboardClient

  constructor(protected config: Interfaces.Config, public options: IOptions = {}) {
    this.config = config

    if (options.required === undefined) options.required = true
    options.preauth = options.preauth !== false
    if (options.debug) debug.enable('http')
    if (options.debug && options.debugHeaders) debug.enable('http,http:headers')
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
    const delinquencyConfig: IDelinquencyConfig = {fetch_delinquency: false, warning_shown: false}
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

      static showWarnings<T>(response: HTTP<T>) {
        const warnings = response.headers['x-heroku-warning'] || response.headers['warning-message']
        if (Array.isArray(warnings))
          warnings.forEach(warning => warn(`${warning}\n`))
        else if (typeof warnings === 'string')
          warn(`${warnings}\n`)
      }

      static configDelinquency(url: string, opts: APIClient.Options): void {
        if (opts.method?.toUpperCase() !== 'GET' || (opts.hostname && opts.hostname !== apiUrl.hostname)) {
          delinquencyConfig.fetch_delinquency = false
          return
        }

        if (/^\/account$/i.test(url)) {
          delinquencyConfig.fetch_url = '/account'
          delinquencyConfig.fetch_delinquency = true
          delinquencyConfig.resource_type = 'account'
          return
        }

        const match = url.match(/^\/teams\/([^#/?]+)/i)
        if (match) {
          delinquencyConfig.fetch_url = `/teams/${match[1]}`
          delinquencyConfig.fetch_delinquency = true
          delinquencyConfig.resource_type = 'team'
          return
        }

        delinquencyConfig.fetch_delinquency = false
      }

      static notifyDelinquency(delinquencyInfo: IDelinquencyInfo): void {
        const suspension = delinquencyInfo.scheduled_suspension_time ? Date.parse(delinquencyInfo.scheduled_suspension_time).valueOf() : undefined
        const deletion = delinquencyInfo.scheduled_deletion_time ? Date.parse(delinquencyInfo.scheduled_deletion_time).valueOf() : undefined

        if (!suspension && !deletion) return

        const resource = delinquencyConfig.resource_type

        if (suspension) {
          const now = Date.now()

          if (suspension > now) {
            warn(`This ${resource} is delinquent with payment and we‘ll suspend it on ${new Date(suspension)}.`)
            delinquencyConfig.warning_shown = true
            return
          }

          if (deletion)
            warn(`This ${resource} is delinquent with payment and we suspended it on ${new Date(suspension)}. If the ${resource} is still delinquent, we‘ll delete it on ${new Date(deletion)}.`)
        } else if (deletion)
          warn(`This ${resource} is delinquent with payment and we‘ll delete it on ${new Date(deletion)}.`)

        delinquencyConfig.warning_shown = true
      }

      // eslint-disable-next-line complexity
      static async request<T>(url: string, opts: APIClient.Options = {}, retries = 3): Promise<APIHTTPClient<T>> {
        opts.headers = opts.headers || {}
        const currentRequestId = RequestId.create() && RequestId.headerValue

        // Accumulation of requestIds in the header
        // causes a header overflow error. These have been
        // observed to be larger than 8k (Node default max)
        // in long running poll operations such as pg:wait
        if (Buffer.from(currentRequestId).byteLength > 1024 * 8) {
          RequestId.empty()
          opts.headers[requestIdHeader] = RequestId.create()
        } else {
          opts.headers[requestIdHeader] = currentRequestId
        }

        if (!Object.keys(opts.headers).some(h => h.toLowerCase() === 'authorization')) {
          opts.headers.authorization = `Bearer ${self.auth}`
        }

        this.configDelinquency(url, opts)

        retries--
        try {
          let response: HTTP<T>
          let particleboardResponse: HTTP<IDelinquencyInfo> | undefined
          const particleboardClient: ParticleboardClient = self.particleboard

          if (delinquencyConfig.fetch_delinquency && !delinquencyConfig.warning_shown) {
            self._particleboard.auth = self.auth
            const settledResponses = await Promise.allSettled([
              super.request<T>(url, opts),
              particleboardClient.get<IDelinquencyInfo>(delinquencyConfig.fetch_url as string),
            ])

            // Platform API request
            if (settledResponses[0].status === 'fulfilled')
              response = settledResponses[0].value
            else
              throw settledResponses[0].reason

            // Particleboard request (ignore errors)
            if (settledResponses[1].status === 'fulfilled') {
              particleboardResponse = settledResponses[1].value
            }
          } else {
            response = await super.request<T>(url, opts)
          }

          const delinquencyInfo: IDelinquencyInfo = particleboardResponse?.body || {}
          this.notifyDelinquency(delinquencyInfo)

          this.trackRequestIds<T>(response)
          this.showWarnings<T>(response)
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

  get particleboard(): ParticleboardClient {
    if (this._particleboard) return this._particleboard
    this._particleboard = new deps.ParticleboardClient(this.config)
    return this._particleboard
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
