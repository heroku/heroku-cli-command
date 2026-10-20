import type {
  FetchLike,
  HerokuApiClientLike,
  HerokuApiRequestOptions,
  HerokuApiResponse,
} from '@heroku/heroku-credential-manager/login'
import type {IncomingHttpHeaders} from 'node:http'

import {getDefaultDispatcher} from '@heroku/heroku-fetch/client/environment-defaults.js'
import {HTTPError, type HTTPRequestOptions} from '@heroku/http-call'
import {fetch as undiciFetch, type RequestInit as UndiciRequestInit} from 'undici'

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

function authorizationHeaders(headers: HerokuApiRequestOptions['headers'], token: string): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== 'authorization') forwarded[name] = value
  }

  forwarded.Authorization = `Bearer ${token}`
  return forwarded
}

function platformOptions(options: HerokuApiRequestOptions | undefined, token: string): CommandRequestOptions {
  const platformRequestOptions: CommandRequestOptions = {
    headers: authorizationHeaders(options?.headers, token),
    partial: true,
    retryAuth: false,
  }

  // Only set signal/timeout when the caller supplied them. http-call merges
  // options over its defaults with Object.assign, so an explicit `undefined`
  // here would overwrite http-call's default request timeout (60s) and leave
  // the request able to hang indefinitely.
  if (options?.signal !== undefined) platformRequestOptions.signal = options.signal
  if (options?.timeoutMs !== undefined) platformRequestOptions.timeout = options.timeoutMs

  return platformRequestOptions
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

/**
 * Rebuilds a FetchLike call as plain `(url, init)` arguments that the installed
 * undici's `fetch` accepts.
 *
 * A `Request` constructed from Node's global constructor is backed by Node's
 * built-in (bundled) undici and is not recognized by the installed undici's
 * `fetch` (the brand check is per-copy), so a `Request` must be decomposed into
 * a URL + init rather than forwarded as-is. The body is buffered because the
 * only `Request`s the login module sends through the proxy path carry small
 * JSON payloads.
 */
async function toUndiciArgs(
  input: Parameters<FetchLike>[0],
  init: Parameters<FetchLike>[1],
): Promise<[string, UndiciRequestInit]> {
  if (typeof input === 'string' || input instanceof URL) {
    return [input.toString(), (init ?? {}) as UndiciRequestInit]
  }

  const headers: Record<string, string> = {}
  input.headers.forEach((value, key) => {
    headers[key] = value
  })
  const hasBody = input.method !== 'GET' && input.method !== 'HEAD'
  const requestInit: UndiciRequestInit = {
    body: hasBody ? await input.arrayBuffer() : undefined,
    headers,
    method: input.method,
    redirect: input.redirect,
    signal: input.signal,
    // An explicit `init` wins over the Request's own fields, matching fetch semantics.
    ...(init as UndiciRequestInit),
  }
  return [input.url, requestInit]
}

/**
 * Creates a FetchLike backed by the platform's fetch, routed through an
 * HTTP(S)_PROXY / NO_PROXY-aware undici dispatcher when a proxy env var is set.
 *
 * The credential-manager login module sets `redirect: 'error'` and its own
 * AbortSignal on every request and owns its poll retry, so this adapter only
 * layers proxy support onto fetch: fetch already honors `redirect: 'error'` and
 * the abort signal, and custom CAs are honored through the standard
 * NODE_EXTRA_CA_CERTS.
 *
 * When a dispatcher is present the request runs on the installed undici's own
 * `fetch` rather than Node's built-in global `fetch`: `getDefaultDispatcher()`
 * builds the `EnvHttpProxyAgent` from the installed undici, and Node's built-in
 * fetch bundles a different undici whose dispatcher handler interface is
 * incompatible with it (it throws `invalid onRequestStart method`). Pairing the
 * dispatcher with the matching `fetch` keeps both on the same undici copy.
 *
 * TODO: this is a bridge. Once heroku-fetch exports a matched fetch+dispatcher
 * pair from `@heroku/heroku-fetch/client/environment-defaults.js`, consume that
 * instead and drop both the direct `undici` dependency and `toUndiciArgs` below.
 */
export function createCredentialManagerFetchAdapter(): FetchLike {
  // Resolve the proxy dispatcher once per adapter: EnvHttpProxyAgent owns a
  // connection pool, so a fresh one must not be built on every request.
  const dispatcher = getDefaultDispatcher()
  return async (input, init) => {
    const resolved = await dispatcher
    if (resolved) {
      const [url, undiciInit] = await toUndiciArgs(input, init)
      const response = await undiciFetch(url, {
        ...undiciInit,
        dispatcher: resolved as UndiciRequestInit['dispatcher'],
      })
      return response as unknown as Response
    }

    // No proxy configured: Node's built-in fetch handles the request directly.
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Node 20+ provides fetch at runtime; the lint engine's compatibility table predates that support
    return fetch(input, init)
  }
}
