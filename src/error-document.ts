import ansis from 'ansis'
import {inspect} from 'node:util'

/**
 * The `--json` error document: a fixed, documented set of fields, the same for
 * every command. Built from an allowlist, so object graphs an error happens to
 * reference (the command, its Config, the API client and its token, HTTP
 * request and response objects) never reach stdout.
 */
export type ErrorDocument = {
  /** The error's cause, built the same way, up to {@link MAX_CAUSE_DEPTH} levels deep. */
  cause?: ErrorDocument;
  /** A machine-readable error code, such as `HEROKU_NONINTERACTIVE_LOGIN` or `ENOTFOUND`. */
  code?: string;
  /** The process exit code. Top level only. */
  exitCode?: number;
  /** The API error id, such as `not_found`. */
  id?: string;
  message: string;
  /** The error class name, such as `NotFoundError`. */
  name: string;
  /** The API resource the error is about, such as `app`. */
  resource?: string;
  /** The HTTP status code of a failed API request. */
  statusCode?: number;
  suggestions?: string[];
  /** A documentation link the API sent with the error. */
  url?: string;
}

/** Longest `message`, in characters. Longer values are cut and end with `…`. */
export const MAX_MESSAGE_LENGTH = 4096
/** Longest `url` or suggestion, in characters. */
export const MAX_TEXT_LENGTH = 1024
/** Longest `name`, `code`, `id` or `resource`, in characters. */
export const MAX_SHORT_LENGTH = 256
/** Most suggestions kept. */
export const MAX_SUGGESTIONS = 5
/** Most nested causes kept. */
export const MAX_CAUSE_DEPTH = 3
/**
 * Largest serialized document, in characters. Deeper causes, then suggestions,
 * are dropped to fit, and as a last resort the message is shortened.
 */
export const MAX_DOCUMENT_LENGTH = 16_384

const REDACTED = '[REDACTED]'

type ErrorFields = {
  body?: {id?: unknown; resource?: unknown; url?: unknown};
  cause?: unknown;
  code?: unknown;
  http?: {statusCode?: unknown};
  id?: unknown;
  message?: unknown;
  name?: unknown;
  resource?: unknown;
  statusCode?: unknown;
  suggestions?: unknown;
}

export type ErrorDocumentOptions = {
  /** The exit code to report. */
  exitCode: number;
  /** Exact values to redact wherever they appear, such as the loaded API token. */
  secrets?: Array<string | undefined>;
}

/**
 * Redact secrets from text: each exact value in `secrets` (8 characters or
 * longer, so short values don't redact ordinary words), then patterns for Heroku tokens,
 * Authorization header values and URL credentials. Patterns can't catch legacy UUID-format tokens, which look like any
 * other id, so callers pass the loaded token as an exact value.
 */
export function redactSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let result = text
  for (const secret of secrets) {
    if (secret && secret.length >= 8) result = result.split(secret).join(REDACTED)
  }

  return result
    // Heroku API tokens.
    .replaceAll(/\bHRKU-[\w-]+/g, '[REDACTED]')
    // Authorization header values.
    .replaceAll(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [REDACTED]')
    // Credentials in URLs, such as postgres://user:password@host.
    .replaceAll(/\b([a-z][\d+.a-z-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}

/** The full error, stack included, for debug output on stderr. Secrets are redacted. */
export function debugErrorText(err: unknown, secrets: Array<string | undefined> = []): string {
  return redactSecrets(inspect(err, {depth: 2}), secrets)
}

export function toErrorDocument(err: unknown, {exitCode, secrets = []}: ErrorDocumentOptions): ErrorDocument {
  const text = (value: unknown, max = MAX_SHORT_LENGTH): string | undefined => {
    if (typeof value !== 'string') return undefined
    return truncate(redactSecrets(ansis.strip(value), secrets), max)
  }

  const build = (value: unknown, depth: number, seen: Set<unknown>): ErrorDocument => {
    if (!(value instanceof Error)) {
      return {message: text(String(value), MAX_MESSAGE_LENGTH) ?? '', name: 'Error'}
    }

    seen.add(value)
    const e = value as Error & ErrorFields
    const read = <T>(get: () => T): T | undefined => {
      // A getter on a third-party error can throw; a missing field is better than no document.
      try {
        return get()
      } catch {
        return undefined
      }
    }

    const statusCode = read(() => e.statusCode ?? e.http?.statusCode)
    const suggestions = read(() => e.suggestions)
    const cause = read(() => e.cause)
    const document: ErrorDocument = {
      message: text(read(() => e.message), MAX_MESSAGE_LENGTH) ?? '',
      name: text(read(() => e.name)) || 'Error',
    }
    const code = text(read(() => e.code))
    const id = text(read(() => e.id ?? e.body?.id))
    const resource = text(read(() => e.resource ?? e.body?.resource))
    const url = text(read(() => e.body?.url), MAX_TEXT_LENGTH)
    if (code) document.code = code
    if (typeof statusCode === 'number') document.statusCode = statusCode
    if (id) document.id = id
    if (resource) document.resource = resource
    if (url) document.url = url
    if (Array.isArray(suggestions)) {
      const kept = suggestions.slice(0, MAX_SUGGESTIONS).map(s => text(s, MAX_TEXT_LENGTH)).filter((s): s is string => Boolean(s))
      if (kept.length > 0) document.suggestions = kept
    }

    if (cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH && !seen.has(cause)) {
      document.cause = build(cause, depth + 1, seen)
    }

    return document
  }

  const document = {...build(err, 0, new Set()), exitCode}
  return fitToLimit(document)
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Drop the deepest cause, then suggestions, then shorten the message, until the serialized document fits. */
function fitToLimit(document: ErrorDocument): ErrorDocument {
  const tooLong = () => JSON.stringify(document).length > MAX_DOCUMENT_LENGTH
  while (tooLong() && document.cause) {
    let parent = document
    while (parent.cause?.cause) parent = parent.cause
    delete parent.cause
  }

  if (tooLong()) delete document.suggestions
  // JSON escaping can grow a string up to sixfold (control characters become \uXXXX).
  while (tooLong() && document.message.length > 1) {
    document.message = truncate(document.message, Math.floor(document.message.length / 2))
  }

  return document
}
