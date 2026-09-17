import type {Config} from '@oclif/core/interfaces'

import {HTTP, HTTPError, HTTPRequestOptions} from '@heroku/http-call'
import {CLIError, warn} from '@oclif/core/errors'
import {ux} from '@oclif/core/ux'
import debug from 'debug'
import * as url from 'node:url'
import {inspect} from 'node:util'

import {getStorageConfig} from './credential-manager-core/lib/credential-storage-selector.js'
import {deleteLoginState, loginStateDataDir, readLoginState} from './credential-manager-core/lib/login-state.js'
import {
  type AuthEntry,
  credentialServiceForApiHost,
  getAuth as getStoredAuth,
  isCredentialNotFoundError,
} from './credential-manager.js'
import {protectDebugOutput} from './http-debug.js'
import {Login} from './login.js'
import {Mutex} from './mutex.js'
import {IDelinquencyConfig, IDelinquencyInfo, ParticleboardClient} from './particleboard-client.js'
import {prompter} from './prompter.js'
import {RequestId, requestIdHeader} from './request-id.js'
import {
  type ResolvedVars,
  vars,
} from './vars.js'
import {yubikey} from './yubikey.js'

export const ALLOWED_HEROKU_DOMAINS = Object.freeze(['heroku.com', 'herokai.com', 'herokuspace.com', 'herokudev.com'])
export const LOCALHOST_DOMAINS = Object.freeze(['localhost', '127.0.0.1'])
const CANONICAL_API_ORIGIN = 'https://api.heroku.com'
const CANONICAL_PARTICLEBOARD_ORIGIN = 'https://particleboard.heroku.com'

function automaticDelinquencyAllowed(apiUrl: URL, particleboardUrl: undefined | URL): boolean {
  if (apiUrl.origin !== CANONICAL_API_ORIGIN) return false
  return particleboardUrl?.origin === CANONICAL_PARTICLEBOARD_ORIGIN
}

function resolveParticleboardUrl(): undefined | URL {
  try {
    return new URL(vars.particleboardUrl)
  } catch {}
}

function isLoopback(hostname: string): boolean {
  const normalized = normalizeHostname(hostname).toLowerCase()
  if (normalized === 'localhost' || normalized === '::1') return true
  const octets = normalized.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function requestTarget(requestUrl: string, opts: APIClient.Options, apiUrl: URL, defaultHost: null | string | undefined = apiUrl.hostname): URL {
  let parsed: undefined | URL
  try {
    parsed = new URL(requestUrl)
  } catch {}

  const relative = parsed ?? new URL(requestUrl, apiUrl)
  const protocol = parsed?.protocol || opts.protocol || apiUrl.protocol
  const hostname = normalizeHostname(String(opts.hostname || parsed?.hostname || defaultHost || apiUrl.hostname))
  const port = parsed?.port || opts.port || apiUrl.port || (protocol === 'https:' ? 443 : 80)
  const formattedHostname = hostname.includes(':') ? `[${hostname}]` : hostname
  const userinfo = relative.username || relative.password ? `${relative.username}:${relative.password}@` : ''
  return new URL(`${protocol}//${userinfo}${formattedHostname}:${port}${relative.pathname}${relative.search}`)
}

function authorizationAllowed(target: URL): boolean {
  const isHerokuApi = ALLOWED_HEROKU_DOMAINS.some(domain => target.hostname.endsWith(`.${domain}`) || target.hostname === domain)
  const isLocalhost = isLoopback(target.hostname)
  const safeProtocol = target.protocol === 'https:' || (target.protocol === 'http:' && isLocalhost)
  return safeProtocol && (isHerokuApi || isLocalhost)
}

const SENSITIVE_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'heroku-two-factor-code',
  'proxy-authorization',
  requestIdHeader.toLowerCase(),
  'x-addon-sso',
])

function isSensitiveRequestHeader(header: string): boolean {
  const normalized = header.toLowerCase()
  return SENSITIVE_REQUEST_HEADERS.has(normalized) || normalized.startsWith('x-heroku-')
}

function cloneRequestOptions(opts: APIClient.Options): APIClient.Options {
  return {
    ...opts,
    headers: {...opts.headers},
  }
}

function isReadableStream(body: unknown): body is NodeJS.ReadableStream {
  return typeof body === 'object' && body !== null && typeof (body as NodeJS.ReadableStream).pipe === 'function'
}

const isolateHeaders = Symbol('isolateHeaders')
const NON_REPLAYABLE_BODY_ERROR = 'Cannot redispatch a request with a non-replayable body'

function hasHeader(headers: NonNullable<APIClient.Options['headers']>, name: string): boolean {
  const normalizedName = name.toLowerCase()
  return Object.keys(headers).some(header => header.toLowerCase() === normalizedName)
}

function setHeader(headers: NonNullable<APIClient.Options['headers']>, name: string, value: string | string[] | undefined): void {
  for (const header of Object.keys(headers)) {
    if (header.toLowerCase() === name.toLowerCase()) delete headers[header]
  }

  headers[name] = value
}

function untrustedHeaders(headers: NonNullable<APIClient.Options['headers']>): NonNullable<APIClient.Options['headers']> {
  const sanitized: NonNullable<APIClient.Options['headers']> = {}
  for (const [header, value] of Object.entries(headers)) {
    const normalized = header.toLowerCase()
    if (!isSensitiveRequestHeader(normalized)) sanitized[normalized] = value
  }

  return sanitized
}

const UNSAFE_ROUTING_OPTIONS = ['agent', 'createConnection', 'lookup', 'socketPath'] as const

function sanitizeRequestTransport(opts: APIClient.Options): void {
  delete opts.auth
  for (const option of UNSAFE_ROUTING_OPTIONS) {
    if (opts[option] !== undefined) throw new Error(`APIClient does not support the ${option} request option`)
  }
}

function validateRequestTransport(opts: APIClient.Options, kind = 'request', allowedAgent?: unknown): void {
  if (opts.auth !== undefined) throw new Error(`APIClient does not support ${kind} auth`)
  for (const option of UNSAFE_ROUTING_OPTIONS) {
    if (option === 'agent' && opts.agent === allowedAgent) continue
    if (opts[option] !== undefined) throw new Error(`APIClient does not support ${kind} ${option}`)
  }
}

function routingOptions(opts: APIClient.Options): Pick<APIClient.Options, 'host' | 'hostname' | 'port' | 'protocol'> {
  return Object.fromEntries(['host', 'hostname', 'port', 'protocol'].map(option => [option, opts[option as keyof APIClient.Options]]))
}

function validateRequestRoute(opts: APIClient.Options, expected: APIClient.Options): void {
  for (const option of ['host', 'hostname', 'port', 'protocol'] as const) {
    if (opts[option] !== expected[option]) throw new Error(`APIClient does not support post-construction ${option} mutation`)
  }
}

function redirectOriginForDiagnostic(target: URL): string {
  return target.origin === 'null' ? `${target.protocol}//[opaque]` : target.origin
}

function apiDiagnosticUrl(input: string): string {
  try {
    const target = new URL(input)
    const exactRoutes = new Set([
      '/account',
      '/apps',
      '/debug-secrets',
      '/oauth/authorizations',
      '/oauth/authorizations/~',
      '/oauth/sessions/~',
    ])
    let route = exactRoutes.has(target.pathname) ? target.pathname : undefined
    if (/^\/oauth\/authorizations\/[^/]+$/.test(target.pathname)) route = '/oauth/authorizations/:id'
    return `${redirectOriginForDiagnostic(target)}${route ?? '/[redacted]'}`
  } catch {
    return '[redacted URL]'
  }
}

function responseDocumentationUrl(input: unknown): string | undefined {
  if (typeof input !== 'string') return
  try {
    const target = new URL(input)
    const safeArticlePath = /^\/articles\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(target.pathname)
    const safeFragment = !target.hash || /^#[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.hash)
    if (target.protocol !== 'https:'
      || target.hostname !== 'devcenter.heroku.com'
      || target.port
      || target.username
      || target.password
      || target.search
      || !safeArticlePath
      || !safeFragment) return
    return target.href
  } catch {}
}

function isStructuredErrorBody(body: unknown): body is IHerokuAPIErrorOptions & Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
}

function sanitizeResponseBodyUrl(body: IHerokuAPIErrorOptions & Record<string, unknown>): IHerokuAPIErrorOptions & Record<string, unknown> {
  const sanitized = {...body}
  const documentationUrl = responseDocumentationUrl(sanitized.url)
  if (documentationUrl) sanitized.url = documentationUrl
  else delete sanitized.url
  return sanitized
}

function setHTTPErrorBody(httpError: HTTPError, body: unknown): void {
  httpError.body = body
  httpError.http.body = body
}

function setHTTPErrorFallbackMessage(httpError: HTTPError, body: IHerokuAPIErrorOptions & Record<string, unknown>): void {
  const requestUrl = typeof httpError.http.url === 'string' ? apiDiagnosticUrl(httpError.http.url) : '[redacted URL]'
  httpError.message = `HTTP Error ${httpError.http.statusCode} for ${httpError.http.method} ${requestUrl}\n${inspect(body)}`
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace APIClient {
  export interface Options extends HTTPRequestOptions {
    [isolateHeaders]?: boolean
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
  app?: {id: string; name: string}
  id?: string
  message?: string
  resource?: string
  url?: string
}

class StoredCredentialIncompleteError extends Error {}

export class HerokuAPIError extends CLIError {
  body: IHerokuAPIErrorOptions
  http: HTTPError

  constructor(httpError: HTTPError) {
    if (!httpError) throw new Error('invalid error')
    const rawOptions: unknown = httpError.body
    if (!isStructuredErrorBody(rawOptions)) throw httpError
    const options = sanitizeResponseBodyUrl(rawOptions)
    setHTTPErrorBody(httpError, options)

    if (typeof options.message !== 'string' || !options.message.trim()) {
      setHTTPErrorFallbackMessage(httpError, options)
      Error.captureStackTrace(httpError, HerokuAPIError)
      throw httpError
    }

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
  preauthPromises: {[k: string]: Promise<HTTP<any>>}
  readonly resolvedVars: ResolvedVars
  private _account?: string
  private _auth?: string
  private readonly _login: Login
  private _particleboard!: ParticleboardClient
  /** Invalidates storage reads that began before an explicit auth state change. */
  private _storedAuthGeneration = 0
  /** In-flight dedupe for concurrent getAuthEntry() calls before resolution completes. */
  private _storedAuthPromise?: Promise<AuthEntry | undefined>
  /** After a failed read from storage, skip re-querying until state is reset (login/logout/auth setter). */
  private _storedAuthResolvedAbsent = false
  private _twoFactorMutex: Mutex<string> | undefined
  private readonly particleboardEndpoint?: string

  constructor(protected config: Config, public options: IOptions = {}, resolvedVars: ResolvedVars = vars.resolve()) {
    this.config = config
    this.resolvedVars = resolvedVars
    this._login = new Login(this.config, this, this.resolvedVars)
    if (options.required === undefined) options.required = true
    options.preauth = options.preauth !== false
    if (options.debug) debug.enable('http')
    if (options.debug && options.debugHeaders) debug.enable('http,http:headers')
    this.options = options
    const apiUrl = new url.URL(this.resolvedVars.apiUrl)
    const particleboardUrl = resolveParticleboardUrl()
    this.particleboardEndpoint = particleboardUrl?.href
    const automaticDelinquencyEnabled = automaticDelinquencyAllowed(apiUrl, particleboardUrl)
    const envHeaders = JSON.parse(process.env.HEROKU_HEADERS || '{}')
    this.preauthPromises = {}
    const self = this as any
    const opts = {
      headers: {
        accept: 'application/vnd.heroku+json; version=3',
        'user-agent': `heroku-cli/${self.config.version} ${self.config.platform}`,
        ...envHeaders,
      },
      host: normalizeHostname(apiUrl.hostname),
      port: apiUrl.port,
      protocol: apiUrl.protocol,
    }
    const delinquencyConfig: IDelinquencyConfig = {fetch_delinquency: false, warning_shown: false}
    const shownHeaderWarnings = new Set<string>()
    const routingDefaults = {
      host: normalizeHostname(apiUrl.hostname),
      port: apiUrl.port,
      protocol: apiUrl.protocol,
    }
    const internallyPreparedOptions = new WeakSet<APIClient.Options>()
    const dispatchedStreamBodies = new WeakSet<object>()

    const prepareRequestOptions = (requestUrl: string, requestOptions: APIClient.Options, defaults: APIClient.Options): APIClient.Options => {
      for (const option of UNSAFE_ROUTING_OPTIONS) {
        if (defaults[option] !== undefined) throw new Error(`APIClient does not support mutable default ${option}`)
      }

      if (defaults.auth !== undefined) throw new Error('APIClient does not support mutable default auth')
      if (defaults.hostname !== undefined) throw new Error('APIClient does not support mutable default hostname')
      for (const option of ['port', 'protocol'] as const) {
        if (defaults[option] !== routingDefaults[option]) throw new Error(`APIClient does not support mutable default ${option}`)
      }

      const prepared = cloneRequestOptions(requestOptions)
      const target = requestTarget(requestUrl, prepared, apiUrl, defaults.host)
      if (target.username || target.password) {
        throw new Error(`APIClient does not support credentialed request URLs at ${redirectOriginForDiagnostic(target)}`)
      }

      const internalDirectTransport = internallyPreparedOptions.has(requestOptions)
        && target.protocol === 'http:'
        && isLoopback(target.hostname)
        && prepared.agent === false
      if (internalDirectTransport) validateRequestTransport(prepared, 'internally prepared request', false)
      else sanitizeRequestTransport(prepared)
      if (target.protocol === 'http:' && isLoopback(target.hostname)) prepared.agent = false
      if (!authorizationAllowed(target)) {
        prepared.headers = untrustedHeaders(prepared.headers!)
        if (prepared.body !== undefined
          && typeof prepared.body === 'object'
          && !Buffer.isBuffer(prepared.body)
          && !isReadableStream(prepared.body)
          && !hasHeader(prepared.headers, 'content-type')) {
          prepared.headers['content-type'] = 'application/json'
        }

        for (const header of Object.keys(defaults.headers ?? {})) {
          const explicit = Object.entries(requestOptions.headers ?? {})
            .find(([requestHeader]) => requestHeader.toLowerCase() === header.toLowerCase())
          if (!explicit || explicit[1] === undefined || explicit[1] === defaults.headers?.[header]) prepared.headers[header] = undefined
        }

        prepared[isolateHeaders] = true
      }

      internallyPreparedOptions.add(prepared)
      return prepared
    }

    this.http = class APIHTTPClient<T> extends HTTP.create(opts)<T> {
      private readonly callerSuppliedAuthorization: boolean
      private readonly directTransport: boolean
      private readonly originalOrigin: string
      private redirectCount = 0
      private redirectUrl: URL
      private routingSnapshot: APIClient.Options
      private transportPrepared = false

      constructor(requestUrl: string, requestOptions: APIClient.Options = {}) {
        const prepared = internallyPreparedOptions.has(requestOptions)
          ? cloneRequestOptions(requestOptions)
          : prepareRequestOptions(requestUrl, requestOptions, APIHTTPClient.defaults)
        super(requestUrl, prepared)
        this.directTransport = prepared.agent === false
        if (this.directTransport) this.options.agent = false
        protectDebugOutput(this, isSensitiveRequestHeader, apiDiagnosticUrl)
        if (prepared[isolateHeaders]) {
          const generatedEntityHeaders = prepared.body
            ? {
              'content-length': this.options.headers['content-length'],
              'content-type': this.options.headers['content-type'],
            }
            : {}
          this.options.headers = Object.fromEntries(Object.entries({
            ...prepared.headers,
            ...generatedEntityHeaders,
          }).filter(([, value]) => value !== undefined)) as typeof this.options.headers
        }

        this.redirectUrl = requestTarget(requestUrl, this.options, apiUrl, this.options.host)
        this.originalOrigin = this.redirectUrl.origin
        this.callerSuppliedAuthorization = hasHeader(prepared.headers!, 'authorization')
        this.routingSnapshot = routingOptions(this.options)
      }

      static configDelinquency(url: string, opts: APIClient.Options): void {
        if (!automaticDelinquencyEnabled || opts.method?.toUpperCase() !== 'GET' || (opts.hostname && opts.hostname !== apiUrl.hostname)) {
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
            warn(`This ${resource} is delinquent with payment and we'll suspend it on ${new Date(suspension)}.`)
            delinquencyConfig.warning_shown = true
            return
          }

          if (deletion)
            warn(`This ${resource} is delinquent with payment and we suspended it on ${new Date(suspension)}. If the ${resource} is still delinquent, we'll delete it on ${new Date(deletion)}.`)
        } else if (deletion)
          warn(`This ${resource} is delinquent with payment and we'll delete it on ${new Date(deletion)}.`)

        delinquencyConfig.warning_shown = true
      }

      // eslint-disable-next-line complexity
      static async request<T>(url: string, requestOpts: APIClient.Options = {}, retries = 3, generatedAuthorization = false): Promise<APIHTTPClient<T>> {
        const opts = prepareRequestOptions(url, requestOpts, this.defaults)
        const targetUrl = requestTarget(url, opts, apiUrl, this.defaults.host)
        const targetAllowsAuthorization = authorizationAllowed(targetUrl)
        const callerSuppliedAuthorization = !generatedAuthorization && hasHeader(opts.headers!, 'authorization')
        const requestUsesGeneratedAuthorization = generatedAuthorization || (targetAllowsAuthorization && !callerSuppliedAuthorization)
        this.configDelinquency(url, opts)

        retries--
        try {
          let response: HTTP<T>
          let particleboardResponse: HTTP<IDelinquencyInfo> | undefined

          if (delinquencyConfig.fetch_delinquency && !delinquencyConfig.warning_shown) {
            const particleboardClient: ParticleboardClient = self.particleboard
            particleboardClient.auth = await self.getAuth()
            const settledResponses = await Promise.allSettled([
              super.request<T>(url, opts),
              particleboardClient.get<IDelinquencyInfo>(delinquencyConfig.fetch_url as string),
            ])

            // Platform API request
            if (settledResponses[0].status === 'fulfilled')
              response = settledResponses[0].value
            else
              throw settledResponses[0].reason

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
          return response as APIHTTPClient<T>
        } catch (error) {
          if (!(error instanceof HTTPError)) throw error
          if (retries > 0) {
            if (requestUsesGeneratedAuthorization && opts.retryAuth !== false && error.http.statusCode === 401) {
              if (process.env.HEROKU_API_KEY) {
                throw new Error('The token provided to HEROKU_API_KEY is invalid. Please double-check that you have the correct token, or run `heroku login` without HEROKU_API_KEY set.')
              }

              if (!self.authPromise) self.authPromise = self.login()
              await self.authPromise
              setHeader(opts.headers!, 'authorization', `Bearer ${await self.getAuth()}`)
              return this.request<T>(url, opts, retries, true)
            }

            if (targetAllowsAuthorization && error.http.statusCode === 403 && error.body.id === 'two_factor') {
              return this.twoFactorRetry(error, url, opts, {generatedAuthorization: requestUsesGeneratedAuthorization, retries})
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
        retry?: {generatedAuthorization: boolean; retries: number},
      ): Promise<APIHTTPClient<any>> {
        const {generatedAuthorization = false, retries = 3} = retry ?? {}
        const app = err.body.app ? err.body.app.name : null
        if (!app || !options.preauth) {
          opts.headers = opts.headers || {}
          opts.headers['Heroku-Two-Factor-Code'] = await self.twoFactorPrompt()
          return this.request(url, opts, retries, generatedAuthorization)
        }

        // if multiple requests are run in parallel for the same app, we should
        // only preauth for the first so save the fact we already preauthed
        if (!self.preauthPromises[app]) {
          self.preauthPromises[app] = self.twoFactorPrompt().then((factor: any) => self.preauth(app, factor))
        }

        await self.preauthPromises[app]
        return this.request(url, opts, retries, generatedAuthorization)
      }

      async _redirect(): Promise<void> {
        this.redirectCount++
        if (this.redirectCount > 10) throw new Error(`Redirect loop at ${redirectOriginForDiagnostic(this.redirectUrl)}`)
        const {location} = this.headers
        const [firstLocation] = Array.isArray(location) ? location : [location]
        if (!firstLocation) throw new Error(`Redirect from ${redirectOriginForDiagnostic(this.redirectUrl)} has no location header`)

        const target = new URL(firstLocation, this.redirectUrl)
        if (target.origin !== this.originalOrigin) {
          throw new Error(`Refusing cross-origin redirect from ${redirectOriginForDiagnostic(this.redirectUrl)} to ${redirectOriginForDiagnostic(target)}`)
        }

        if (target.username || target.password) {
          throw new Error(`Refusing credentialed API redirect at ${redirectOriginForDiagnostic(target)}`)
        }

        this.redirectUrl = target
        this.url = target.href
        if (this.directTransport) this.options.agent = false
        this.routingSnapshot = {
          ...this.routingSnapshot,
          host: normalizeHostname(target.hostname),
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          protocol: target.protocol,
        }
        await this._request()
      }

      async _request(): Promise<void> {
        validateRequestTransport(this.ctor.defaults, 'mutable default')
        for (const option of ['port', 'protocol'] as const) {
          if (this.ctor.defaults[option] !== routingDefaults[option]) throw new Error(`APIClient does not support mutable default ${option}`)
        }

        validateRequestTransport(this.options, 'request', this.directTransport ? false : undefined)
        validateRequestRoute(this.options, this.routingSnapshot)
        if (this.directTransport) this.options.agent = false
        if (isReadableStream(this.options.body)) {
          if (dispatchedStreamBodies.has(this.options.body)) throw new Error(NON_REPLAYABLE_BODY_ERROR)
          dispatchedStreamBodies.add(this.options.body)
        }

        if (!this.transportPrepared) {
          this.transportPrepared = true
          const targetAllowsAuthorization = authorizationAllowed(this.redirectUrl)

          // Accumulation of requestIds in the header causes a header overflow
          // error in long-running poll operations such as pg:wait.
          if (targetAllowsAuthorization) {
            const currentRequestId = RequestId.create() && RequestId.headerValue
            if (Buffer.from(currentRequestId).byteLength > 1024 * 7) {
              RequestId.empty()
              setHeader(this.options.headers, requestIdHeader, RequestId.create())
            } else {
              setHeader(this.options.headers, requestIdHeader, currentRequestId)
            }

            if (!this.callerSuppliedAuthorization) {
              setHeader(this.options.headers, 'authorization', `Bearer ${await self.getAuth()}`)
            }
          }
        }

        await super._request()
      }
    }
  }

  get auth(): string | undefined {
    return process.env.HEROKU_API_KEY || this._auth
  }

  set auth(token: string | undefined) {
    this.setAuthEntry(token ? {account: undefined, token} : undefined)
  }

  get defaults(): typeof HTTP.defaults {
    return this.http.defaults
  }

  get particleboard(): ParticleboardClient {
    if (this._particleboard) return this._particleboard
    if (!this.particleboardEndpoint) throw new Error('Invalid Particleboard URL')
    this._particleboard = new ParticleboardClient(this.config, this.particleboardEndpoint)
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

  async getAuth(): Promise<string | undefined> {
    const authEntry = await this.getAuthEntry()
    return authEntry?.token
  }

  async getAuthEntry(): Promise<AuthEntry | undefined> {
    if (process.env.HEROKU_API_TOKEN && !process.env.HEROKU_API_KEY) warn('HEROKU_API_TOKEN is set but you probably meant HEROKU_API_KEY')
    if (process.env.HEROKU_API_KEY) {
      return {account: undefined, token: process.env.HEROKU_API_KEY}
    }

    if (this._auth) return {account: this._account, token: this._auth}

    if (this._storedAuthResolvedAbsent) return undefined

    if (!this._storedAuthPromise) {
      const generation = this._storedAuthGeneration
      const storedAuthPromise = this.readStoredAuth(generation)
      this._storedAuthPromise = storedAuthPromise
      const clearStoredAuthPromise = () => {
        if (this._storedAuthPromise === storedAuthPromise) this._storedAuthPromise = undefined
      }

      storedAuthPromise.then(clearStoredAuthPromise, clearStoredAuthPromise)
    }

    const storedEntry = await this._storedAuthPromise
    return process.env.HEROKU_API_KEY
      ? {account: undefined, token: process.env.HEROKU_API_KEY}
      : storedEntry
  }

  login(opts: Login.Options = {}) {
    return this._login.login(opts)
  }

  async logout() {
    const logoutGeneration = this._storedAuthGeneration
    try {
      if (logoutGeneration !== this._storedAuthGeneration) return
      // Login owns the shared lifecycle lock before resolving storage so an
      // older logout cannot start cleanup after another client persists login.
      await this._login.logout()
    } catch (error) {
      if (error instanceof CLIError) {
        // Remote API failures have historically warned without rejecting logout.
        // Local cleanup failures are plain errors from the login package and still reject.
        warn(error)
        return
      }

      throw error
    } finally {
      if (logoutGeneration === this._storedAuthGeneration) this.setAuthEntry(undefined)
    }
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

  setAuthEntry(entry: AuthEntry | undefined) {
    delete this.authPromise
    this._auth = entry?.token
    this._account = entry?.account
    this.resetStoredAuthResolution()
  }

  stream(url: string, options: APIClient.Options = {}) {
    return this.http.stream(url, options)
  }

  twoFactorPrompt() {
    if (!process.stdin.isTTY) {
      return Promise.reject(new Error('Two-factor authentication requires an interactive terminal.'))
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

  private cachedAuthEntry(): AuthEntry | undefined {
    return this._auth ? {account: this._account, token: this._auth} : undefined
  }

  private async readStoredAuth(generation: number): Promise<AuthEntry | undefined> {
    const {credentialStore, useNetrc} = getStorageConfig()
    const credentialService = credentialServiceForApiHost(this.resolvedVars.apiHost)
    const useLoginState = Boolean(credentialStore
      && !useNetrc
      && this.config.dataDir)
    const loginStateDir = useLoginState
      ? loginStateDataDir(this.config.dataDir, this.resolvedVars.apiHost, credentialService)
      : undefined
    try {
      const cachedAccount = loginStateDir
        ? (await readLoginState(loginStateDir))?.account
        : undefined
      const {account, token} = await getStoredAuth(cachedAccount, this.resolvedVars.apiHost, credentialService)
      if (!account?.trim() || !token?.trim()) throw new StoredCredentialIncompleteError('Stored credential is incomplete')
      if (generation !== this._storedAuthGeneration) return this.cachedAuthEntry()
      this._auth = token
      this._account = account
      this._storedAuthResolvedAbsent = false
      return {account: this._account, token: this._auth}
    } catch (error) {
      if (generation !== this._storedAuthGeneration) return this.cachedAuthEntry()
      const incompleteCredential = error instanceof StoredCredentialIncompleteError
      if (!incompleteCredential && !isCredentialNotFoundError(error, this.resolvedVars.apiHost)) throw error
      if (loginStateDir) {
        await deleteLoginState(loginStateDir)
      }

      if (generation !== this._storedAuthGeneration) return this.cachedAuthEntry()
      this._storedAuthResolvedAbsent = true
      return undefined
    }
  }

  private resetStoredAuthResolution(): void {
    this._storedAuthGeneration++
    this._storedAuthPromise = undefined
    this._storedAuthResolvedAbsent = false
  }
}
