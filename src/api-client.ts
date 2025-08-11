import {HTTP, HTTPError, HTTPRequestOptions} from '@heroku/http-call'
import {Errors, Interfaces} from '@oclif/core'
import debug from 'debug'
import inquirer from 'inquirer'
import {Netrc} from 'netrc-parser'
import * as url from 'node:url'

import {Login} from './login.js'
import {Mutex} from './mutex.js'
import {IDelinquencyConfig, IDelinquencyInfo, ParticleboardClient} from './particleboard-client.js'
import {RequestId, requestIdHeader} from './request-id.js'
import {vars} from './vars.js'
import {yubikey} from './yubikey.js'

const netrc = new Netrc()

export const ALLOWED_HEROKU_DOMAINS = ['heroku.com', 'herokai.com', 'herokuspace.com', 'herokudev.com'] as const
export const LOCALHOST_DOMAINS = ['localhost', '127.0.0.1'] as const

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace APIClient {
  export interface Options extends HTTPRequestOptions {
    retryAuth?: boolean
  }
}

export interface IOptions {
  debug?: boolean
  debugHeaders?: boolean
  preauth?: boolean
  required?: boolean
}

export interface IHerokuAPIErrorOptions {
  app?: { id: string; name: string }
  id?: string
  message?: string
  resource?: string
  url?: string
}

export class HerokuAPIError extends Errors.CLIError {
  body: IHerokuAPIErrorOptions
  http: HTTPError

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
  authPromise?: Promise<HTTP<any>>
  http: typeof HTTP
  preauthPromises: { [k: string]: Promise<HTTP<any>> }
  private _auth?: string
  private readonly _login: Login
  private _particleboard!: ParticleboardClient
  private _twoFactorMutex: Mutex<string> | undefined

  constructor(protected config: Interfaces.Config, public options: IOptions = {}) {
    this.config = config
    this._login = new Login(this.config, this)
    if (options.required === undefined) options.required = true
    options.preauth = options.preauth !== false
    if (options.debug) debug.enable('http')
    if (options.debug && options.debugHeaders) debug.enable('http,http:headers')
    this.options = options
    const apiUrl = new url.URL(vars.apiUrl)
    const envHeaders = JSON.parse(process.env.HEROKU_HEADERS || '{}')
    this.preauthPromises = {}
    const self = this as any
    const opts = {
      headers: {
        accept: 'application/vnd.heroku+json; version=3',
        'user-agent': `heroku-cli/${self.config.version} ${self.config.platform}`,
        ...envHeaders,
      },
      host: apiUrl.hostname,
      port: apiUrl.port,
      protocol: apiUrl.protocol,
    }
    const delinquencyConfig: IDelinquencyConfig = {fetch_delinquency: false, warning_shown: false}
    this.http = class APIHTTPClient<T> extends HTTP.create(opts)<T> {
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
            Errors.warn(`This ${resource} is delinquent with payment and we'll suspend it on ${new Date(suspension)}.`)
            delinquencyConfig.warning_shown = true
            return
          }

          if (deletion)
            Errors.warn(`This ${resource} is delinquent with payment and we suspended it on ${new Date(suspension)}. If the ${resource} is still delinquent, we'll delete it on ${new Date(deletion)}.`)
        } else if (deletion)
          Errors.warn(`This ${resource} is delinquent with payment and we'll delete it on ${new Date(deletion)}.`)

        delinquencyConfig.warning_shown = true
      }

      // eslint-disable-next-line complexity
      static async request<T>(url: string, opts: APIClient.Options = {}, retries = 3): Promise<APIHTTPClient<T>> {
        opts.headers = opts.headers || {}
        const currentRequestId = RequestId.create() && RequestId.headerValue

        // Accumulation of requestIds in the header
        // causes a header overflow error. Headers have been
        // observed to be larger than 8k (Node default max)
        // in long running poll operations such as pg:wait
        // We limit the Request-Id header to 7k to allow some
        // room fo other headers.
        if (Buffer.from(currentRequestId).byteLength > 1024 * 7) {
          RequestId.empty()
          opts.headers[requestIdHeader] = RequestId.create()
        } else {
          opts.headers[requestIdHeader] = currentRequestId
        }

        if (!Object.keys(opts.headers).some(h => h.toLowerCase() === 'authorization')) {
          // Handle both relative and absolute URLs for security check
          let targetUrl: URL
          try {
            // Try absolute URL first
            targetUrl = new URL(url)
          } catch {
            // If that fails, assume it's relative and prepend the API base URL
            targetUrl = new URL(url, vars.apiUrl)
          }

          const isHerokuApi = ALLOWED_HEROKU_DOMAINS.some(domain => targetUrl.hostname.endsWith(`.${domain}`))
          const isLocalhost = LOCALHOST_DOMAINS.includes(targetUrl.hostname as (typeof LOCALHOST_DOMAINS)[number])

          if (isHerokuApi || isLocalhost) {
            opts.headers.authorization = `Bearer ${self.auth}`
          }
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
          if (!(error instanceof HTTPError)) throw error
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

      static showWarnings<T>(response: HTTP<T>) {
        const warnings = response.headers['x-heroku-warning'] || response.headers['warning-message']
        if (Array.isArray(warnings))
          warnings.forEach(warning => Errors.warn(`${warning}\n`))
        else if (typeof warnings === 'string')
          Errors.warn(`${warnings}\n`)
      }

      static trackRequestIds<T>(response: HTTP<T>) {
        const responseRequestIdHeader = response.headers[requestIdHeader] || response.headers[requestIdHeader.toLocaleLowerCase()]
        if (responseRequestIdHeader) {
          const requestIds = Array.isArray(responseRequestIdHeader) ? responseRequestIdHeader : responseRequestIdHeader.split(',')
          RequestId.track(...requestIds)
        }
      }

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
    }
  }

  get auth(): string | undefined {
    if (!this._auth) {
      if (process.env.HEROKU_API_TOKEN && !process.env.HEROKU_API_KEY) Errors.warn('HEROKU_API_TOKEN is set but you probably meant HEROKU_API_KEY')
      this._auth = process.env.HEROKU_API_KEY
      if (!this._auth) {
        netrc.loadSync()
        this._auth = netrc.machines[vars.apiHost] && netrc.machines[vars.apiHost].password
      }
    }

    return this._auth
  }

  set auth(token: string | undefined) {
    delete this.authPromise
    this._auth = token
  }

  get defaults(): typeof HTTP.defaults {
    return this.http.defaults
  }

  get particleboard(): ParticleboardClient {
    if (this._particleboard) return this._particleboard
    this._particleboard = new ParticleboardClient(this.config)
    return this._particleboard
  }

  get twoFactorMutex(): Mutex<string> {
    if (!this._twoFactorMutex) {
      this._twoFactorMutex = new Mutex()
    }

    return this._twoFactorMutex
  }

  delete<T>(url: string, options: APIClient.Options = {}) {
    return this.http.delete<T>(url, options)
  }

  get<T>(url: string, options: APIClient.Options = {}) {
    return this.http.get<T>(url, options)
  }

  login(opts: Login.Options = {}) {
    return this._login.login(opts)
  }

  async logout() {
    try {
      await this._login.logout()
    } catch (error) {
      if (error instanceof Errors.CLIError) Errors.warn(error)
    }

    delete netrc.machines['api.heroku.com']
    delete netrc.machines['git.heroku.com']
    await netrc.save()
  }

  patch<T>(url: string, options: APIClient.Options = {}) {
    return this.http.patch<T>(url, options)
  }

  post<T>(url: string, options: APIClient.Options = {}) {
    return this.http.post<T>(url, options)
  }

  preauth(app: string, factor: string) {
    return this.put(`/apps/${app}/pre-authorizations`, {
      headers: {'Heroku-Two-Factor-Code': factor},
    })
  }

  put<T>(url: string, options: APIClient.Options = {}) {
    return this.http.put<T>(url, options)
  }

  request<T>(url: string, options: APIClient.Options = {}) {
    return this.http.request<T>(url, options)
  }

  stream(url: string, options: APIClient.Options = {}) {
    return this.http.stream(url, options)
  }

  twoFactorPrompt() {
    yubikey.enable()
    return this.twoFactorMutex.synchronize(async () => {
      try {
        const {factor} = await inquirer.prompt([{
          mask: '*',
          message: 'Two-factor code',
          name: 'factor',
          type: 'password',
        }])
        yubikey.disable()
        return factor
      } catch (error) {
        yubikey.disable()
        throw error
      }
    })
  }
}
