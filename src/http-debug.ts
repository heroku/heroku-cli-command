import {HTTP, HTTPRequestOptions} from '@heroku/http-call'
import {URL} from 'node:url'

interface DebuggableHTTP {
  _debugRequest(): void
  _debugResponse(): void
  _renderHeaders(headers: NodeJS.Dict<unknown>): string
  body: unknown
  options: HTTPRequestOptions
  url: string
}

function effectiveUrl(client: HTTP<unknown>): string | undefined {
  const {host, hostname, path = '/', port, protocol} = client.options
  const rawHostname = String(hostname || host || '')
  const formattedHostname = rawHostname.includes(':') && !rawHostname.startsWith('[') ? `[${rawHostname}]` : rawHostname
  if (!protocol || !formattedHostname) return
  const defaultPort = protocol === 'https:' ? '443' : '80'
  const explicitPort = port && String(port) !== defaultPort ? `:${port}` : ''
  return `${protocol}//${formattedHostname}${explicitPort}${path}`
}

function redirectOriginForDiagnostic(target: URL): string {
  return target.origin === 'null' ? `${target.protocol}//[opaque]` : target.origin
}

function genericDiagnosticUrl(input: string): string {
  try {
    const target = new URL(input)
    return `${redirectOriginForDiagnostic(target)}/[redacted]`
  } catch {
    return '[redacted URL]'
  }
}

export function protectDebugOutput(
  client: HTTP<unknown>,
  sensitiveHeader: (header: string) => boolean,
  diagnosticUrl: (url: string) => string = genericDiagnosticUrl,
): void {
  const instance = client as unknown as DebuggableHTTP
  const prototype = HTTP.prototype as unknown as Pick<DebuggableHTTP, '_debugRequest' | '_debugResponse' | '_renderHeaders'>
  const urlDescriptor = Object.getOwnPropertyDescriptor(HTTP.prototype, 'url')
  if (typeof prototype._debugRequest !== 'function'
    || typeof prototype._debugResponse !== 'function'
    || typeof prototype._renderHeaders !== 'function'
    || typeof urlDescriptor?.set !== 'function') {
    throw new TypeError('Unsupported @heroku/http-call private debug hook contract')
  }

  Object.defineProperty(instance, 'url', {
    configurable: true,
    get: () => diagnosticUrl(effectiveUrl(client) ?? ''),
    set(value) {
      urlDescriptor.set!.call(client, value)
    },
  })

  instance._renderHeaders = headers => prototype._renderHeaders.call(client, Object.fromEntries(Object.entries(headers).map(([header, value]) => [
    header,
    sensitiveHeader(header) ? '[REDACTED]' : value,
  ])))
  instance._debugRequest = () => {
    const {agent, body} = instance.options
    instance.options.agent = undefined
    instance.options.body = undefined
    try {
      prototype._debugRequest.call(client)
    } finally {
      instance.options.agent = agent
      instance.options.body = body
    }
  }

  instance._debugResponse = () => {
    const {body, response} = client
    const {headers} = response

    instance.body = undefined
    response.headers = Object.fromEntries(Object.entries(headers).map(([header, value]) => [
      header,
      sensitiveHeader(header) || header.toLowerCase() === 'set-cookie' ? '[REDACTED]' : value,
    ]))
    try {
      prototype._debugResponse.call(client)
    } finally {
      instance.body = body
      response.headers = headers
    }
  }
}
