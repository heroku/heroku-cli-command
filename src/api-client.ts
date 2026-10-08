import type {Config} from '@oclif/core/interfaces'

import {NativeCredentialNotFoundError} from '@heroku/heroku-credential-manager'
import {HTTP, HTTPError, type HTTPRequestOptions} from '@heroku/http-call'
import {CLIError, warn} from '@oclif/core/errors'
import {ux} from '@oclif/core/ux'
import debug from 'debug'
import {access} from 'node:fs/promises'
import path from 'node:path'

import {getStorageConfig} from './credential-manager-core/lib/credential-storage-selector.js'
import {readLoginState} from './credential-manager-core/lib/login-state.js'
import {type AuthEntry, getAuth as getStoredAuth, removeAuth} from './credential-manager.js'
import {
  deleteLoginStateIf,
  getLoginStateRevision,
  type LoginStateRevision,
} from './login-state-coordinator.js'
import {Login} from './login.js'
import {Mutex} from './mutex.js'
import {type IDelinquencyConfig, type IDelinquencyInfo, ParticleboardClient} from './particleboard-client.js'
import {prompter} from './prompter.js'
import {RequestId, requestIdHeader} from './request-id.js'
import {vars} from './vars.js'
import {yubikey} from './yubikey.js'

export const ALLOWED_HEROKU_DOMAINS = Object.freeze(['heroku.com', 'herokai.com', 'herokuspace.com', 'herokudev.com'])
export const LOCALHOST_DOMAINS = Object.freeze(['localhost', '127.0.0.1'])

function credentialService(): string {
  return vars.apiHost === 'api.heroku.com' ? 'heroku-cli' : `heroku-cli@${vars.apiHost}`
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace APIClient {
  export type Options = HTTPRequestOptions & {
    retryAuth?: boolean;
  }
}

export type IOptions = {
  debug?: boolean;
  debugHeaders?: boolean;
  preauth?: boolean;
  required?: boolean;
}

export type IHerokuAPIErrorOptions = {
  app?: {id: string; name: string};
  id?: string;
  message?: string;
  resource?: string;
  url?: string;
}

export class HerokuAPIError extends CLIError {
  body: IHerokuAPIErrorOptions
  http: HTTPError

  constructor(httpError: HTTPError) {
    if (!httpError) throw new Error('invalid error')
    const options: IHerokuAPIErrorOptions = httpError.body
    if (!options?.message) throw httpError
    const info = []
    if (options.id) info.push(`Error ID: ${options.id}`)
    if (options.app?.name) info.push(`App: ${options.app.name}`)
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
  preauthPromises: Record<string, Promise<HTTP<any>>>
  private _account?: string
  private _auth?: string
  /** Orders explicit login/logout transactions without blocking unrelated API requests. */
  private _authLifecycle = Promise.resolve()
  /** Invalidates async credential reads and conditional logout resets after newer auth mutations. */
  private _authResolutionGeneration = 0
  private readonly _login: Login
  private _particleboard!: ParticleboardClient
  /** In-flight dedupe for concurrent getAuthEntry() calls before resolution completes. */
  private _storedAuthPromise?: Promise<AuthEntry | undefined>
  /** After a failed read from storage, skip re-querying until state is reset (login/logout/auth setter). */
  private _storedAuthResolvedAbsent = false
  private _twoFactorMutex: Mutex<string> | undefined

  constructor(protected config: Config, public options: IOptions = {}) {
    this.config = config
    this._login = new Login(this.config, this)
    if (options.required === undefined) options.required = true
    options.preauth = options.preauth !== false
    if (options.debug) debug.enable('http')
    if (options.debug && options.debugHeaders) debug.enable('http,http:headers')
    this.options = options
    const apiUrl = new URL(vars.apiUrl)
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
    const shownHeaderWarnings = new Set<string>()
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

        const match = /^\/teams\/([^#/?]+)/i.exec(url)
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
            warn(`This ${resource} is delinquent with payment and we'll suspend it on ${new Date(suspension).toString()}.`)
            delinquencyConfig.warning_shown = true
            return
          }

          if (deletion)
            warn(`This ${resource} is delinquent with payment and we suspended it on ${new Date(suspension).toString()}. If the ${resource} is still delinquent, we'll delete it on ${new Date(deletion).toString()}.`)
        } else if (deletion)
          warn(`This ${resource} is delinquent with payment and we'll delete it on ${new Date(deletion).toString()}.`)

        delinquencyConfig.warning_shown = true
      }

      // eslint-disable-next-line complexity
      static async request<T>(url: string, opts: APIClient.Options = {}, retries = 3): Promise<APIHTTPClient<T>> {
        opts.headers ||= {}
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

        let auth: string | undefined
        if (Object.keys(opts.headers).every(h => h.toLowerCase() !== 'authorization')) {
          // Handle both relative and absolute URLs for validation
          let targetUrl: URL
          try {
            // Try absolute URL first
            targetUrl = new URL(url)
          } catch {
            // If that fails, assume it's relative and prepend the API base URL
            targetUrl = new URL(url, vars.apiUrl)
          }

          const isHerokuApi = ALLOWED_HEROKU_DOMAINS.some(domain => targetUrl.hostname.endsWith(`.${domain}`) || targetUrl.hostname === domain)
          const isLocalhost = LOCALHOST_DOMAINS.includes(targetUrl.hostname)

          if (isHerokuApi || isLocalhost) {
            auth = await self.getAuth()
            opts.headers.authorization = `Bearer ${auth}`
          }
        }

        this.configDelinquency(url, opts)

        retries--
        try {
          let response: HTTP<T>
          let particleboardResponse: HTTP<IDelinquencyInfo> | undefined

          if (delinquencyConfig.fetch_delinquency && !delinquencyConfig.warning_shown) {
            const particleboardClient: ParticleboardClient = self.particleboard
            particleboardClient.auth = auth ?? await self.getAuth()
            const settledResponses = await Promise.allSettled([
              super.request<T>(url, opts),
              particleboardClient.get<IDelinquencyInfo>(delinquencyConfig.fetch_url!),
            ])

            // Platform API request
            if (settledResponses[0].status === 'fulfilled')
              response = settledResponses[0].value
            else
              throw settledResponses[0].reason as Error

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
            if (opts.retryAuth !== false && error.http.statusCode === 401) {
              if (process.env.HEROKU_API_KEY) {
                throw new Error('The token provided to HEROKU_API_KEY is invalid. Please double-check that you have the correct token, or run `heroku login` without HEROKU_API_KEY set.', {cause: error})
              }

              self.authPromise ||= self.login()
              await self.authPromise
              const retryAuth = await self.getAuth()
              opts.headers.authorization = `Bearer ${retryAuth}`
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
        const emitIfNew = (raw: string) => {
          const normalized = raw.replace(/^\s*warning:?\s*/i, '').trim()
          if (!normalized || shownHeaderWarnings.has(normalized)) return
          shownHeaderWarnings.add(normalized)
          warn(normalized)
        }

        if (Array.isArray(warnings))
          for (const warning of warnings) emitIfNew(warning)
        else if (typeof warnings === 'string')
          emitIfNew(warnings)
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
          opts.headers ||= {}
          opts.headers['Heroku-Two-Factor-Code'] = await self.twoFactorPrompt()
          return this.request(url, opts, retries)
        }

        // if multiple requests are run in parallel for the same app, we should
        // only preauth for the first so save the fact we already preauthed
        self.preauthPromises[app] ||= self.twoFactorPrompt().then((factor: any) => self.preauth(app, factor))

        await self.preauthPromises[app]
        return this.request(url, opts, retries)
      }
    }
  }

  get auth(): string | undefined {
    return this._auth
  }

  set auth(token: string | undefined) {
    delete this.authPromise
    this._auth = token
    this.resetStoredAuthResolution()
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
    this._twoFactorMutex ||= new Mutex()

    return this._twoFactorMutex
  }

  async delete<T>(url: string, options: APIClient.Options = {}) {
    return this.http.delete<T>(url, options)
  }

  async get<T>(url: string, options: APIClient.Options = {}) {
    return this.http.get<T>(url, options)
  }

  async getAuth(): Promise<string | undefined> {
    const authEntry = await this.getAuthEntry()
    return authEntry?.token
  }

  async getAuthEntry(): Promise<AuthEntry | undefined> {
    if (this._auth) return {account: this._account, token: this._auth}
    if (process.env.HEROKU_API_TOKEN && !process.env.HEROKU_API_KEY) warn('HEROKU_API_TOKEN is set but you probably meant HEROKU_API_KEY')
    if (process.env.HEROKU_API_KEY) {
      this.setAuthEntry({account: undefined, token: process.env.HEROKU_API_KEY})
      return {account: this._account, token: this._auth}
    }

    if (this._storedAuthResolvedAbsent) return undefined

    if (!this._storedAuthPromise) {
      const generation = this._authResolutionGeneration
      const storedAuthPromise = (async (): Promise<AuthEntry | undefined> => {
        const {credentialStore} = getStorageConfig()
        const useLoginState = Boolean(credentialStore && this.config.dataDir)
        let cachedAccount: string | undefined
        let loginStatePresent = false
        let loginStateRevision: LoginStateRevision | undefined
        try {
          loginStateRevision = useLoginState
            ? await getLoginStateRevision(this.config.dataDir)
            : undefined
          loginStatePresent = useLoginState && await this.loginStateExists()
          cachedAccount = useLoginState
            ? (await readLoginState(this.config.dataDir))?.account
            : undefined
          const {account, token} = await getStoredAuth(cachedAccount, vars.apiHost, credentialService())
          const entry = {account, token}
          if (generation === this._authResolutionGeneration) {
            this._auth = token
            this._account = account
            this._storedAuthResolvedAbsent = false
          }

          return entry
        } catch (error) {
          if (!this.isMissingCredentialError(error)) throw error

          if (useLoginState && generation === this._authResolutionGeneration) {
            this.scheduleStaleLoginStateCleanup(cachedAccount, generation, loginStatePresent, loginStateRevision)
          }

          if (generation === this._authResolutionGeneration) this._storedAuthResolvedAbsent = true
          return undefined
        } finally {
          if (generation === this._authResolutionGeneration) this._storedAuthPromise = undefined
        }
      })()
      this._storedAuthPromise = storedAuthPromise
    }

    return this._storedAuthPromise
  }

  async login(opts: Login.Options = {}): Promise<void> {
    return this.serializeAuthLifecycle(async () => this._login.login(opts))
  }

  async logout(): Promise<void> {
    return this.serializeAuthLifecycle(async () => {
      const entry = await this.getAuthEntry()
      const generation = this._authResolutionGeneration
      try {
        if (entry?.account?.trim() && entry.token?.trim()) {
          await this._login.logoutEntry({account: entry.account, token: entry.token})
        } else if (entry?.token) {
          const results = await Promise.allSettled([
            this._login.logout(entry.token),
            removeAuth(undefined, [vars.apiHost, vars.httpGitHost], credentialService(), entry.token),
          ])
          const localFailure = results.slice(1).find(result => result.status === 'rejected')
          if (localFailure?.status === 'rejected') throw localFailure.reason as Error
          if (results[0].status === 'rejected') throw results[0].reason as Error
        }
      } catch (error) {
        if (error instanceof CLIError) warn(error)
      } finally {
        if (
          generation === this._authResolutionGeneration
          && this._account === entry?.account
          && this._auth === entry?.token
        ) {
          if (entry === undefined && this._account === undefined && this._auth === undefined) {
            this.resetStoredAuthResolutionWithoutInvalidation()
          } else {
            this.setAuthEntry(undefined)
          }
        }
      }
    })
  }

  async patch<T>(url: string, options: APIClient.Options = {}) {
    return this.http.patch<T>(url, options)
  }

  async post<T>(url: string, options: APIClient.Options = {}) {
    return this.http.post<T>(url, options)
  }

  async preauth(app: string, factor: string) {
    return this.put(`/apps/${app}/pre-authorizations`, {
      headers: {'Heroku-Two-Factor-Code': factor},
    })
  }

  async put<T>(url: string, options: APIClient.Options = {}) {
    return this.http.put<T>(url, options)
  }

  async request<T>(url: string, options: APIClient.Options = {}) {
    return this.http.request<T>(url, options)
  }

  setAuthEntry(entry: AuthEntry | undefined) {
    delete this.authPromise
    this._auth = entry?.token
    this._account = entry?.account
    this.resetStoredAuthResolution()
  }

  async stream(url: string, options: APIClient.Options = {}) {
    return this.http.stream(url, options)
  }

  async twoFactorPrompt() {
    if (!process.stdin.isTTY) {
      throw new Error('Two-factor authentication requires an interactive terminal.')
    }

    yubikey.enable()
    return this.twoFactorMutex.synchronize(async () => {
      try {
        const result = await ux.action.pauseAsync(async () => {
          try {
            const {factor} = await prompter.prompt<{factor: string}>([{
              mask: '*',
              message: 'Two-factor code',
              name: 'factor',
              type: 'password',
            }])
            return {factor}
          } catch (error) {
            return {error}
          }
        })
        if ('error' in result) throw result.error
        return result.factor
      } finally {
        yubikey.disable()
      }
    })
  }

  private isMissingCredentialError(error: unknown): boolean {
    if (error instanceof NativeCredentialNotFoundError) return true
    if (!(error instanceof Error)) return false
    return [`No auth found for ${vars.apiHost}`, 'Netrc credential does not match the requested account for host', 'No auth found'].includes(error.message)
  }

  private async loginStateExists(): Promise<boolean> {
    if (!this.config.dataDir) return false
    try {
      await access(path.join(this.config.dataDir, 'login.json'))
      return true
    } catch {
      return false
    }
  }

  private resetStoredAuthResolution(): void {
    this._authResolutionGeneration++
    this._storedAuthPromise = undefined
    this._storedAuthResolvedAbsent = false
  }

  private resetStoredAuthResolutionWithoutInvalidation(): void {
    this._storedAuthPromise = undefined
    this._storedAuthResolvedAbsent = false
  }

  private scheduleStaleLoginStateCleanup(
    account: string | undefined,
    generation: number,
    loginStatePresent: boolean,
    loginStateRevision: LoginStateRevision | undefined,
  ): void {
    if (!loginStatePresent || !loginStateRevision || !this.config.dataDir) return
    const cleanup = async () => {
      await deleteLoginStateIf(this.config.dataDir, loginStateRevision, current => {
        const stateMatches = account === undefined ? current === undefined : current?.account === account
        return stateMatches && generation === this._authResolutionGeneration
      })
    }

    // Credential-read callers must resolve before queued login/logout work that may be awaiting the same read.
    // Keep cleanup best-effort and ordered behind already-invoked lifecycle transactions.
    this.serializeAuthLifecycle(cleanup).catch(() => {})
  }

  private async serializeAuthLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this._authLifecycle.then(operation, operation)
    this._authLifecycle = result.then(() => {}, () => {})
    return result
  }
}
