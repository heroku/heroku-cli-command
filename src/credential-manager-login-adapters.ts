import type {
  FetchLike,
  HerokuApiClientLike,
  HerokuApiRequestOptions,
  HerokuApiResponse,
} from '@heroku/heroku-credential-manager/login'
import type {IncomingHttpHeaders, OutgoingHttpHeaders} from 'node:http'

import {HTTP, HTTPError, type HTTPRequestOptions} from '@heroku/http-call'
import {Agent as HttpsAgent} from 'node:https'
import {createRequire} from 'node:module'
import {Readable} from 'node:stream'

type CommandResponse<T> = {
  body: T;
  headers: IncomingHttpHeaders;
  statusCode: number;
}

type CommandRequestOptions = HTTPRequestOptions & {
  retryAuth?: boolean;
}

/** Command transport surface required by the operation-token Platform adapter. */
export type CommandPlatformClient = {
  delete<T>(path: string, options?: CommandRequestOptions): Promise<CommandResponse<T>>;
  get<T>(path: string, options?: CommandRequestOptions): Promise<CommandResponse<T>>;
}

/** Declared command transport contract used by the FetchLike adapter. */
export type CommandLoginTransport = typeof HTTP
// TypeScript supplies the fetch declarations used by FetchLike even though ESLint's globals table does not.
// eslint-disable-next-line no-undef
type FetchBody = RequestInit['body']
type ReplayableBody = {
  stream(): Readable;
}
const bodyFactory = Symbol('credential-manager-body-factory')
type ReplayableRequestOptions = HTTPRequestOptions & {
  [bodyFactory]?: () => Readable;
}
const require = createRequire(import.meta.url)
type CommandProxyPolicy = {
  agent(https: boolean, host?: string): unknown;
  certs: Buffer[];
  env: NodeJS.ProcessEnv;
}
const commandProxyPolicy = (require('@heroku/http-call/lib/proxy.js') as {default: CommandProxyPolicy}).default

function authorizationHeaders(headers: HerokuApiRequestOptions['headers'], token: string): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== 'authorization') forwarded[name] = value
  }

  forwarded.Authorization = `Bearer ${token}`
  return forwarded
}

function platformOptions(options: HerokuApiRequestOptions | undefined, token: string): CommandRequestOptions {
  return {
    headers: authorizationHeaders(options?.headers, token),
    partial: true,
    retryAuth: false,
    signal: options?.signal,
    timeout: options?.timeoutMs,
  }
}

function normalizePlatformResponse<T>(response: CommandResponse<T>): HerokuApiResponse<T> {
  const headers: HerokuApiResponse<T>['headers'] = {}
  for (const [name, value] of Object.entries(response.headers)) headers[name.toLowerCase()] = value
  return {
    body: response.body,
    headers,
    status: response.statusCode,
  }
}

async function platformRequest<T>(request: () => Promise<CommandResponse<T>>): Promise<HerokuApiResponse<T>> {
  try {
    return normalizePlatformResponse(await request())
  } catch (error) {
    if (error instanceof HTTPError) return normalizePlatformResponse(error.http)
    throw error
  }
}

/** Binds one operation token to the exact get/delete Platform API surface expected by credential-manager login. */
export function createCredentialManagerPlatformAdapter(client: CommandPlatformClient, token: string): HerokuApiClientLike {
  return {
    delete: async <T>(path: string, options?: HerokuApiRequestOptions) => platformRequest(async () => client.delete<T>(path, platformOptions(options, token))),
    get: async <T>(path: string, options?: HerokuApiRequestOptions) => platformRequest(async () => client.get<T>(path, platformOptions(options, token))),
  }
}

// Node 20 provides these fetch globals at runtime; the lint engine's compatibility table predates that support.
/* eslint-disable n/no-unsupported-features/node-builtins, no-undef */
async function replayableBody(request: Request): Promise<ReplayableBody | undefined> {
  if (request.body === null) return
  const bytes = new Uint8Array(await request.arrayBuffer())
  return {stream: () => Readable.from([bytes])}
}

function requestHeaders(headers: Headers): OutgoingHttpHeaders {
  return Object.fromEntries(headers.entries())
}

function environmentAgent(url: string): HTTPRequestOptions['agent'] {
  const parsed = new URL(url)
  const previousEnvironment = commandProxyPolicy.env
  commandProxyPolicy.env = process.env
  try {
    const secure = parsed.protocol === 'https:'
    const proxyAgent = commandProxyPolicy.agent(secure, parsed.hostname)
    if (proxyAgent) return proxyAgent as HTTPRequestOptions['agent']
    const ca = commandProxyPolicy.certs
    return secure && ca.length > 0 ? new HttpsAgent({ca}) : undefined
  } finally {
    commandProxyPolicy.env = previousEnvironment
  }
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const normalized = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) normalized.append(name, item)
    } else if (value !== undefined) {
      normalized.append(name, value)
    }
  }

  return normalized
}

function responseBody(body: unknown): FetchBody {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new Blob([Uint8Array.from(body)])
  return JSON.stringify(body)
}

function responseBodyForStatus(status: number, body: unknown): FetchBody {
  return [204, 205, 304].includes(status) ? null : responseBody(body)
}

function redirectError(response: CommandResponse<unknown>): TypeError {
  return new TypeError(`Redirects are not allowed (${response.statusCode})`)
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status)
}

async function commandFetch(transport: CommandLoginTransport, input: Request | string | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init)
  if (request.redirect !== 'error') throw new TypeError('Credential manager requests require redirect: error')
  const {signal} = request
  const abortReason = () => signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
  if (signal?.aborted) throw abortReason()
  const replayable = await replayableBody(request)
  const options: ReplayableRequestOptions = {
    body: replayable?.stream(),
    [bodyFactory]: replayable?.stream,
    headers: requestHeaders(request.headers),
    method: request.method,
    partial: true,
    signal,
    timeout: 0,
  }
  try {
    const response = await transport.request<unknown>(request.url, options)
    if (isRedirect(response.statusCode)) throw redirectError(response)
    return new Response(responseBodyForStatus(response.statusCode, response.body), {
      headers: responseHeaders(response.headers),
      status: response.statusCode,
    })
  } catch (error) {
    if (signal?.aborted) throw abortReason()
    if (error instanceof HTTPError) {
      const response = error.http
      if (isRedirect(response.statusCode)) throw redirectError(response)
      return new Response(responseBodyForStatus(response.statusCode, response.body), {
        headers: responseHeaders(response.headers),
        status: response.statusCode,
      })
    }

    throw error
  }
}

/** Creates a FetchLike backed by the declared command transport rather than global fetch. */
export function createCredentialManagerFetchAdapter(transport: CommandLoginTransport = HTTP): FetchLike {
  class RedirectRejectingTransport<T> extends transport<T> {
    constructor(url: string, options?: HTTPRequestOptions) {
      const hasExplicitAgent = Object.hasOwn(options ?? {}, 'agent')
      const agent = hasExplicitAgent ? options?.agent : environmentAgent(url)
      super(url, {...options, agent})
      // HTTP's constructor uses `options.agent || staleGlobalFallback`; overwrite that synchronous fallback even when
      // the current environment intentionally derived a direct/undefined agent. No request starts in `super()`.
      this.options.agent = agent
    }

    async _redirect(): Promise<void> {
      throw redirectError(this)
    }

    // @heroku/http-call has no supported retry-body or redirect policy option, so this narrow subclass hook refreshes
    // only the buffered body before each transport attempt while retaining its proxy/CA/retry implementation.
    async _request(): Promise<void> {
      const {signal} = this.options
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
      const factory = (this.options as ReplayableRequestOptions)[bodyFactory]
      if (factory) this.options.body = factory()
      return super._request()
    }

    async abortableRetryWait(delay: number): Promise<void> {
      const {signal} = this.options
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort)
          resolve()
        }, delay)
        timer.unref()
        const abort = () => {
          clearTimeout(timer)
          reject(signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError'))
        }

        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, {once: true})
      })
    }
  }

  // Preserve http-call 5.5.2's complete _maybeRetry policy while replacing only its private timer primitive.
  // There is no public wait/retry policy hook; runtime dispatch still routes the parent method through this override.
  Object.defineProperty(RedirectRejectingTransport.prototype, '_wait', {
    async value(this: RedirectRejectingTransport<unknown>, delay: number) {
      return this.abortableRetryWait(delay)
    },
  })

  return async (input, init) => commandFetch(RedirectRejectingTransport, input, init)
}
/* eslint-enable n/no-unsupported-features/node-builtins, no-undef */
