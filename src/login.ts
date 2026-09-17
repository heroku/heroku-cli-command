/* eslint-disable n/no-extraneous-import -- installed integration dependency is intentionally local until package metadata lands */
import type {
  LoginHttp,
  LoginHttpRequest,
  LoginHttpResponse,
  LoginPromptSelection,
  LoginResult,
  LoginStorage,
} from '@heroku/heroku-credential-manager/login'
import type {Config} from '@oclif/core/interfaces'
import type {ChildProcess} from 'node:child_process'

import {
  Login as CredentialManagerLogin,
  LoginCancelledError,
  LoginHttpError,
} from '@heroku/heroku-credential-manager/login'
import {HTTP, HTTPError} from '@heroku/http-call'
import {ux} from '@oclif/core/ux'
import ansis from 'ansis'
import * as readline from 'node:readline'

import {APIClient, HerokuAPIError} from './api-client.js'
import {getStorageConfig} from './credential-manager-core/lib/credential-storage-selector.js'
import {
  deleteLoginState,
  loginStateDataDir,
  readLoginState,
  synchronizeLoginLifecycle,
  writeLoginState,
} from './credential-manager-core/lib/login-state.js'
import {
  credentialServiceForApiHost,
  getAuth,
  removeAuth,
  saveAuth,
} from './credential-manager.js'
import {protectDebugOutput} from './http-debug.js'
import {prompter} from './prompter.js'
import {type ResolvedVars, vars} from './vars.js'

const REQUEST_TIMEOUT = 60 * 1000

const SAFE_ERROR_RESPONSE_HEADERS = new Set([
  'content-type',
  'date',
  'request-id',
  'retry-after',
  'x-request-id',
])
const SENSITIVE_LOGIN_HEADERS = new Set([
  'authorization',
  'cookie',
  'heroku-two-factor-code',
  'proxy-authorization',
  'set-cookie',
])
const NON_REPLAYABLE_BODY_ERROR = 'Cannot redispatch a request with a non-replayable body'

function isSensitiveLoginHeader(header: string): boolean {
  const normalized = header.toLowerCase()
  return SENSITIVE_LOGIN_HEADERS.has(normalized) || normalized.startsWith('x-heroku-')
}

function isReadableStream(body: unknown): body is NodeJS.ReadableStream {
  return typeof body === 'object' && body !== null && typeof (body as NodeJS.ReadableStream).pipe === 'function'
}

function isLoopbackHttp(target: URL): boolean {
  if (target.protocol !== 'http:') return false
  const hostname = target.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const octets = hostname.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

function safeErrorHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => SAFE_ERROR_RESPONSE_HEADERS.has(name.toLowerCase())))
}

function safeLoginDiagnosticUrl(url: string): string {
  const target = new URL(url)
  const exactRoutes = new Set([
    '/account',
    '/auth',
    '/oauth/authorizations',
    '/oauth/authorizations/~',
    '/oauth/sessions/~',
  ])
  let route = exactRoutes.has(target.pathname) ? target.pathname : undefined
  if (/^\/oauth\/authorizations\/[^/]+$/.test(target.pathname)) route = '/oauth/authorizations/:id'
  if (/^\/auth\/cli\/browser\/[^/]+$/.test(target.pathname)) route = '/auth/cli/browser/:id'
  return `${redirectOriginForDiagnostic(target)}${route ?? '/[redacted]'}`
}

function safeLoginErrorUrl(url: string | undefined): string | undefined {
  if (!url) return
  try {
    const target = new URL(url)
    if (target.username || target.password) return
    const safe = safeLoginDiagnosticUrl(url)
    return safe.endsWith('/[redacted]') ? undefined : safe
  } catch {
    // Malformed URLs are omitted from public errors.
  }
}

function consistentValue(values: Array<string | undefined>): string | undefined {
  const provided = [...new Set(values.filter((value): value is string => value !== undefined))]
  return provided.length === 1 ? provided[0] : undefined
}

function errorCause(error: unknown): unknown {
  try {
    return (error as {cause?: unknown}).cause
  } catch {
    return undefined
  }
}

function aggregateErrors(error: AggregateError): undefined | unknown[] {
  try {
    return [...error.errors]
  } catch {
    return undefined
  }
}

function safeContainedLoginError(error: unknown, projected = new Map<unknown, Error>()): Error {
  const existing = projected.get(error)
  if (existing) return existing

  if (error instanceof AggregateError) {
    const aggregate = new AggregateError([], 'Login operation failed')
    projected.set(error, aggregate)
    aggregate.errors = (aggregateErrors(error) ?? []).map(child => safeContainedLoginError(child, projected))
    const cause = errorCause(error)
    if (cause !== undefined) {
      Object.defineProperty(aggregate, 'cause', {
        configurable: true,
        value: safeContainedLoginError(cause, projected),
        writable: true,
      })
    }

    return aggregate
  }

  const sanitized = new Error('Login operation failed')
  if ((typeof error === 'object' || typeof error === 'function') && error !== null) projected.set(error, sanitized)
  const cause = errorCause(error)
  if (cause !== undefined) {
    Object.defineProperty(sanitized, 'cause', {
      configurable: true,
      value: safeContainedLoginError(cause, projected),
      writable: true,
    })
  }

  return sanitized
}

function redirectOriginForDiagnostic(target: URL): string {
  return target.origin === 'null' ? `${target.protocol}//[opaque]` : target.origin
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Login {
  export type Method = 'b' | 'browser' | 'i' | 'interactive' | 's' | 'sso'

  export interface Options {
    browser?: string
    expiresIn?: number
    method?: Method
  }
}

export class LoginHttpAdapter implements LoginHttp {
  async request<T>(url: string, options: LoginHttpRequest): Promise<LoginHttpResponse<T>> {
    if (options.signal?.aborted) throw options.signal.reason

    const target = new URL(url)
    if (target.username || target.password) {
      throw new Error(`Refusing credentialed login request at ${redirectOriginForDiagnostic(target)}`)
    }

    const response = new HTTP<T>(url, {
      agent: isLoopbackHttp(target) ? false : undefined,
      body: options.body,
      headers: options.headers,
      method: options.method,
      partial: true,
      timeout: options.timeoutMs ?? REQUEST_TIMEOUT,
    })
    if (isLoopbackHttp(target)) response.options.agent = false
    protectDebugOutput(response, isSensitiveLoginHeader, safeLoginDiagnosticUrl)
    const request = response as unknown as {
      _redirect(): Promise<void>
      _request(): Promise<void>
      _wait(ms: number): Promise<void>
    }
    let currentUrl = new URL(url)
    const trustedOrigin = currentUrl.origin
    const directTransport = isLoopbackHttp(currentUrl)
    let redirectCount = 0
    let streamBodyDispatched = false
    const dispatch = request._request.bind(response)

    request._request = async () => {
      if (directTransport) response.options.agent = false
      if (isReadableStream(response.options.body)) {
        if (streamBodyDispatched) throw new Error(NON_REPLAYABLE_BODY_ERROR)
        streamBodyDispatched = true
      }

      await dispatch()
    }

    request._redirect = async () => {
      redirectCount++
      if (redirectCount > 10) throw new Error(`Redirect loop at ${redirectOriginForDiagnostic(currentUrl)}`)
      currentUrl = this.redirectTarget(response, currentUrl, trustedOrigin)
      response.url = currentUrl.href
      if (directTransport) response.options.agent = false
      await request._request()
    }

    let rejectAbort: (reason?: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    const abort = () => {
      response.request?.destroy(options.signal?.reason)
      rejectAbort(options.signal?.reason)
    }

    options.signal?.addEventListener('abort', abort, {once: true})
    try {
      if (options.signal) {
        const wait = request._wait.bind(response)
        request._wait = ms => this.abortableWait(ms, options.signal!, wait)
      }

      const pending = request._request()
      await Promise.race([pending, aborted])
      return this.response(response, true, safeLoginDiagnosticUrl(currentUrl.href), response.method)
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason
      if (error instanceof HTTPError) return this.response(error.http, false, safeLoginDiagnosticUrl(currentUrl.href), error.http.method)
      throw error
    } finally {
      options.signal?.removeEventListener('abort', abort)
    }
  }

  private async abortableWait(ms: number, signal: AbortSignal, wait: (ms: number) => Promise<void>): Promise<void> {
    if (signal.aborted) throw signal.reason
    let rejectAbort: (reason?: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    const abort = () => rejectAbort(signal.reason)
    signal.addEventListener('abort', abort, {once: true})
    try {
      await Promise.race([wait(ms), aborted])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  private redirectTarget<T>(response: HTTP<T>, currentUrl: URL, trustedOrigin: string): URL {
    const {location} = response.headers
    const [firstLocation] = Array.isArray(location) ? location : [location]
    if (!firstLocation) throw new Error(`Redirect from ${redirectOriginForDiagnostic(currentUrl)} has no location header`)

    const targetUrl = new URL(firstLocation, currentUrl)
    if (targetUrl.origin !== trustedOrigin) {
      throw new Error(`Refusing cross-origin redirect from ${redirectOriginForDiagnostic(currentUrl)} to ${redirectOriginForDiagnostic(targetUrl)}`)
    }

    if (targetUrl.username || targetUrl.password) {
      throw new Error(`Refusing credentialed login redirect at ${redirectOriginForDiagnostic(targetUrl)}`)
    }

    return targetUrl
  }

  private response<T>(response: HTTP<T>, ok: boolean, url: string, method: string): LoginHttpResponse<T> {
    const headers = Object.fromEntries(Object.entries(response.headers).flatMap(([name, value]) => {
      if (value === undefined) return []
      return [[name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value)]]
    }))
    const {body} = response

    const loginResponse: LoginHttpResponse<T> & {method: string; url: string} = {
      body,
      headers,
      method,
      ok,
      status: response.statusCode,
      url,
    }
    return loginResponse
  }
}

export class Login {
  loginHost = process.env.HEROKU_LOGIN_HOST || 'https://cli-auth.heroku.com'
  private activeLoginPrompt?: (reason: unknown) => void
  private activeLoginPromptCompletion?: Promise<void>
  private delegate: CredentialManagerLogin
  private delegateLoginHost: string
  private readonly http = new LoginHttpAdapter()
  private readonly lifecycleCredentialService: string
  private readonly loginVars: ResolvedVars

  constructor(private readonly config: Config, private readonly heroku: APIClient, resolvedVars?: ResolvedVars) {
    this.loginVars = resolvedVars ?? vars.resolve()
    this.lifecycleCredentialService = credentialServiceForApiHost(this.loginVars.apiHost)
    this.delegateLoginHost = this.loginHost
    this.delegate = this.createDelegate(this.delegateLoginHost)
  }

  async login(opts: Login.Options = {}): Promise<void> {
    return synchronizeLoginLifecycle(this.config.dataDir, this.lifecycleCredentialService, () => this.loginUnlocked(opts))
  }

  async logout(entryOrToken?: LoginResult | string): Promise<void> {
    return synchronizeLoginLifecycle(this.config.dataDir, this.lifecycleCredentialService, () => this.logoutUnlocked(entryOrToken))
  }

  private async cancelLoginPrompt(reason: unknown): Promise<void> {
    this.activeLoginPrompt?.(reason)
    await this.activeLoginPromptCompletion
  }

  private createDelegate(loginHost: string, remoteOnly = false): CredentialManagerLogin {
    const credentialService = credentialServiceForApiHost(this.loginVars.apiHost)
    const {credentialStore, useNetrc} = getStorageConfig()
    const scopedLoginStateDir = !remoteOnly
      && credentialService !== 'heroku-cli'
      && credentialStore
      && !useNetrc
      && this.config?.dataDir
      ? loginStateDataDir(this.config.dataDir, this.loginVars.apiHost, credentialService)
      : undefined
    const storage: LoginStorage = {
      deleteLoginState: remoteOnly ? async () => {} : deleteLoginState,
      async getAuth(account, host, service) {
        const selectedAccount = account ?? (scopedLoginStateDir ? (await readLoginState(scopedLoginStateDir))?.account : undefined)
        const entry = await getAuth(selectedAccount, host, service)
        if (!entry.account) throw new Error('Stored credential did not include an account')
        if (!entry.token) throw new Error('Stored credential did not include a token')
        return {account: entry.account, token: entry.token}
      },
      hasNativeStorage() {
        return Boolean(getStorageConfig().credentialStore)
      },
      readLoginState,
      removeAuth: remoteOnly
        ? async () => {}
        : async (account, hosts, service, expectedToken) => {
          let removeFailure: unknown
          try {
            await removeAuth(account, hosts, service, expectedToken)
          } catch (error) {
            removeFailure = error
          }

          let stateFailure: unknown
          if (scopedLoginStateDir) {
            try {
              await deleteLoginState(scopedLoginStateDir)
            } catch (error) {
              stateFailure = error
            }
          }

          if (removeFailure !== undefined && stateFailure !== undefined) {
            throw new AggregateError([removeFailure, stateFailure], 'Credential cleanup failed')
          }

          if (removeFailure !== undefined) throw removeFailure
          if (stateFailure !== undefined) throw stateFailure
        },
      saveAuth: remoteOnly
        ? async () => {}
        : async (account, token, hosts, service) => {
          await saveAuth(account, token, hosts, service)

          if (scopedLoginStateDir) {
            await writeLoginState(scopedLoginStateDir, account)
          }
        },
      writeLoginState: remoteOnly
        ? async () => {}
        : writeLoginState,
    }

    return new CredentialManagerLogin({
      browser: {
        open: async (url, options) => {
          const open = (await import('open')).default
          const child = await open(url, {
            wait: false,
            ...(options?.browser ? {app: {name: options.browser}} : {}),
          })
          this.observeBrowserChild(child)
        },
      },
      config: {
        apiHost: this.loginVars.apiHost,
        apiUrl: this.loginVars.apiUrl,
        dataDir: remoteOnly ? undefined : this.config?.dataDir,
        gitHost: this.loginVars.httpGitHost,
        loginHost,
        requestTimeoutMs: REQUEST_TIMEOUT,
      },
      environment: {get: name => process.env[name]},
      http: this.http,
      output: {
        warn: message => ux.warn(message),
        write: message => ux.stderr(message.startsWith('http') ? ansis.greenBright(message) : message),
      },
      progress: {
        start: message => ux.action.start(message),
        stop() {
          ux.action.stop()
        },
      },
      prompt: {
        accessToken: async () => this.promptValue('password', 'Access token', 'password'),
        email: async previousAccount => {
          ux.stderr('heroku: Enter your login credentials\n')
          return this.promptValue('email', 'Email', 'input', previousAccount)
        },
        loginMethod: () => this.loginMethod(),
        organization: previousOrganization => this.promptValue('orgName', 'Organization name', 'input', previousOrganization),
        password: () => this.promptValue('password', 'Password', 'password'),
        secondFactor: () => this.promptValue('secondFactor', 'Two-factor code', 'password'),
      },
      storage,
      timers: {
        clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
        setTimeout: (handler, timeoutMs) => {
          const timer = setTimeout(() => {
            this.cancelLoginPrompt(new Error('Login timed out')).then(handler).catch(handler)
          }, timeoutMs)
          timer.unref()
          return timer
        },
      },
    })
  }

  private getLoginMethodFromPromptKey(key: string): 'browser' {
    if (key === '\u0003') ux.error('Login cancelled by user', {exit: 130})
    if (key.toLowerCase() === 'q') ux.error('Login cancelled by user', {exit: 0})
    return 'browser'
  }

  private herokuApiError(error: LoginHttpError): HerokuAPIError {
    const context = error as LoginHttpError & {
      headers?: Record<string, string>
      http?: {
        headers?: Record<string, string>
        method?: string
        url?: string
      }
      method?: string
      stack?: string
      url?: string
    }
    const {body} = error
    const headers = safeErrorHeaders(context.headers ?? context.http?.headers)
    const stack = context.stack ?? ''
    const stackMethod = /authorizationCleanup/.test(stack)
      ? 'DELETE'
      : (/createOAuthToken/.test(stack) ? 'POST' : undefined)
    const stackUrl = /createOAuthToken/.test(stack)
      ? `${new URL(this.loginVars.apiUrl).origin}/oauth/authorizations`
      : undefined
    const method = consistentValue([stackMethod, context.method, context.http?.method])
    const safeOrigin = new URL(this.loginVars.apiUrl).origin
    const url = stackMethod === 'DELETE'
      ? `${safeOrigin}/oauth/authorizations/:id`
      : (stackUrl ?? consistentValue([
        safeLoginErrorUrl(context.url),
        safeLoginErrorUrl(context.http?.url),
      ]))
    const response = new HTTP(url ?? 'https://login-error.invalid/', {
      method,
    })
    const responseOptions = response.options as typeof response.options & {port?: number | string}
    if (url) {
      const responseUrl = new URL(url)
      responseOptions.host = responseUrl.host
      responseOptions.port = responseUrl.port || responseOptions.port
    }

    Object.defineProperties(response, {
      body: {
        configurable: true, enumerable: true, value: body ?? {}, writable: true,
      },
      headers: {configurable: true, enumerable: true, value: headers},
      method: {configurable: true, enumerable: true, value: method},
      statusCode: {configurable: true, enumerable: true, value: error.status},
    })
    const http = new HTTPError(response)
    response.body = body
    http.body = body
    Object.assign(http, {headers, method})
    Object.defineProperty(http, 'url', {configurable: true, enumerable: true, value: url})
    if (!url) {
      Object.defineProperty(response, 'url', {configurable: true, enumerable: true, value: undefined})
      http.message = `HTTP Error ${error.status}${method ? ` for ${method}` : ''}\n${this.herokuErrorMessage(error)}`
    }

    const mapped = new HerokuAPIError(Object.assign(new Error(error.message), {
      body: {message: this.herokuErrorMessage(error)},
      statusCode: error.status,
    }) as unknown as HTTPError)
    mapped.body = body as HerokuAPIError['body']
    mapped.http = http
    return mapped
  }

  private herokuErrorMessage(error: LoginHttpError): string {
    const rawBody: unknown = error.body
    const body = rawBody as undefined | {id?: string; message?: string}
    if (body?.message?.trim() && body.id?.trim()) return `${body.message}\n\nError ID: ${body.id}`
    if (body?.message?.trim()) return body.message
    if (body?.id?.trim()) return `Error ID: ${body.id}`
    if (typeof rawBody === 'string' && rawBody.trim()) return rawBody
    return error.message
  }

  private isCurrentOAuthToken(localToken: string, apiToken: string): boolean {
    const match = /^(.*?)\*{10}(.*)$/.exec(apiToken)
    return match ? localToken.startsWith(match[1]) && (!match[2] || localToken.endsWith(match[2])) : localToken === apiToken
  }

  private async loginMethod(): Promise<LoginPromptSelection> {
    ux.stderr(`heroku: Press any key to open up the browser to login or ${ansis.yellow('q')} to exit`)
    if (!process.stdin.isTTY) return {method: 'browser'}

    const rl = readline.createInterface({input: process.stdin, output: process.stdout})
    const rawMode = typeof process.stdin.setRawMode === 'function'
    const previousRawMode = Boolean(process.stdin.isRaw)
    if (rawMode) process.stdin.setRawMode(true)
    process.stdin.resume()
    let cancelPrompt: ((reason: unknown) => void) | undefined
    let onData: ((data: Buffer) => void) | undefined
    try {
      const key = await new Promise<string>((resolve, reject) => {
        cancelPrompt = reject
        onData = data => resolve(data.toString())
        this.activeLoginPrompt = cancelPrompt
        process.stdin.once('data', onData)
      })
      ux.stdout('')
      return {method: this.getLoginMethodFromPromptKey(key)}
    } finally {
      if (onData) process.stdin.removeListener('data', onData)
      if (this.activeLoginPrompt === cancelPrompt) this.activeLoginPrompt = undefined
      if (rawMode) process.stdin.setRawMode(previousRawMode)
      rl.close()
    }
  }

  private async loginUnlocked(opts: Login.Options): Promise<void> {
    try {
      const options = this.normalizeOptions(opts)
      if (this.loginHost !== this.delegateLoginHost) {
        const delegate = this.createDelegate(this.loginHost)
        this.delegate = delegate
        this.delegateLoginHost = this.loginHost
      }

      const entry = await this.delegate.login(options)
      this.heroku.setAuthEntry(entry)
    } catch (error) {
      if (error instanceof LoginCancelledError) {
        ux.error(error.message, {exit: error.exitCode})
      }

      throw this.mapLoginFailure(error)
    }
  }

  private async logoutUnlocked(entryOrToken?: LoginResult | string): Promise<void> {
    const cached = typeof entryOrToken === 'object'
      ? entryOrToken
      : (typeof entryOrToken === 'string' ? undefined : await this.heroku.getAuthEntry())
    const token = typeof entryOrToken === 'string' ? entryOrToken : cached?.token
    const entry = cached?.account && token ? {account: cached.account, token} : undefined
    if (!token) return

    try {
      await (entry
        ? this.delegate.logout(entry)
        : this.createDelegate(this.loginHost, true).logout({account: 'remote-only', token}))
    } catch (error) {
      throw this.mapLoginFailure(error)
    }
  }

  private mapLoginFailure(error: unknown): unknown {
    if (error instanceof LoginHttpError) return this.herokuApiError(error)
    if (!(error instanceof AggregateError)) return error

    const contained = aggregateErrors(error)
    if (!contained) return error
    if (!contained.some(failure => failure instanceof LoginHttpError)) return error

    const safeProjection = new Map<unknown, Error>()
    const projected = contained.map(failure => failure instanceof LoginHttpError
      ? this.herokuApiError(failure)
      : safeContainedLoginError(failure, safeProjection))
    const primary = projected[0] ?? safeContainedLoginError(error, safeProjection)
    if (!(contained[0] instanceof LoginHttpError)) {
      return new AggregateError(projected, primary.message, {cause: primary})
    }

    const mapped = this.herokuApiError(contained[0])
    Object.defineProperties(mapped, {
      cause: {configurable: true, value: primary, writable: true},
      errors: {configurable: true, value: projected, writable: true},
    })
    return mapped
  }

  private normalizeOptions(opts: Login.Options): {browser?: string; expiresIn?: number; method?: 'browser' | 'interactive' | 'sso'} {
    const methods = {b: 'browser', i: 'interactive', s: 'sso'} as const
    const method = opts.method && opts.method in methods
      ? methods[opts.method as keyof typeof methods]
      : opts.method as 'browser' | 'interactive' | 'sso' | undefined
    return {...opts, method}
  }

  private observeBrowserChild(child: ChildProcess): void {
    child.once('error', cause => ux.warn(cause))
    child.once('close', code => {
      if (code !== 0) ux.warn('Cannot open browser. Continue with the manual URL above.')
    })
  }

  private async promptValue(
    name: 'email' | 'orgName' | 'password' | 'secondFactor',
    message: string,
    type: 'input' | 'password',
    defaultValue?: string,
  ): Promise<string> {
    const controller = new AbortController()
    const cancelPrompt = (reason: unknown) => controller.abort(reason)
    const pending = prompter.prompt<Record<typeof name, string>>([{
      ...(defaultValue ? {default: defaultValue} : {}),
      message,
      name,
      type,
    }], {signal: controller.signal})
    const completion = pending.then(() => {}, () => {})
    this.activeLoginPrompt = cancelPrompt
    this.activeLoginPromptCompletion = completion
    try {
      const answer = await pending
      return answer[name]
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      throw error
    } finally {
      if (this.activeLoginPrompt === cancelPrompt) {
        this.activeLoginPrompt = undefined
        this.activeLoginPromptCompletion = undefined
      }
    }
  }

  private showManualBrowserLoginUrl(url: string): void {
    ux.warn('If browser does not open, visit:')
    ux.stderr(ansis.greenBright(url))
  }
}
