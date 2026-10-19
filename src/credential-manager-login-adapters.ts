import type {
  FetchLike,
  HerokuApiClientLike,
  HerokuApiRequestOptions,
  HerokuApiResponse,
} from '@heroku/heroku-credential-manager/login'
import type {IncomingHttpHeaders} from 'node:http'

import {getDefaultDispatcher} from '@heroku/heroku-fetch/client/environment-defaults.js'
import {HTTPError, type HTTPRequestOptions} from '@heroku/http-call'

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

/**
 * Creates a FetchLike backed by the platform's native fetch, routed through an
 * HTTP(S)_PROXY / NO_PROXY-aware undici dispatcher when a proxy env var is set.
 *
 * The credential-manager login module sets `redirect: 'error'` and its own
 * AbortSignal on every request and owns its poll retry, so this adapter only
 * layers proxy support onto native fetch: native fetch already honors
 * `redirect: 'error'` and the abort signal, and custom CAs are honored through
 * the standard NODE_EXTRA_CA_CERTS.
 */
export function createCredentialManagerFetchAdapter(): FetchLike {
  // Resolve the proxy dispatcher once per adapter: EnvHttpProxyAgent owns a
  // connection pool, so a fresh one must not be built on every request.
  const dispatcher = getDefaultDispatcher()
  return async (input, init) => {
    const resolved = await dispatcher
    // undici's `dispatcher` RequestInit extension is not in the DOM fetch lib types.
    // eslint-disable-next-line no-undef
    const requestInit = (resolved ? {...init, dispatcher: resolved} : init) as RequestInit
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Node 20+ provides fetch at runtime; the lint engine's compatibility table predates that support
    return fetch(input, requestInit)
  }
}
