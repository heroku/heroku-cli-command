import {CREDENTIAL_PATTERNS, Scrubber} from '@heroku/js-blanket'
import ansis from 'ansis'
import {inspect} from 'node:util'

/**
 * The `--json` error document: a fixed, documented set of fields, the same for
 * every command. Built from an allowlist, so object graphs an error happens to
 * reference (the command, its Config, the API client and its token, HTTP
 * request and response objects) never reach stdout.
 *
 * The exit code decides success or failure. To tell errors apart, match on
 * `exitCode`, `statusCode`, `id` and `code`. `name` and `message` are for
 * people. New fields may be added, so ignore fields you don't know. The length
 * limits and redaction rules aren't part of the contract.
 */
export type JsonErrorDocument = {
  /** The error's cause, built the same way, up to {@link MAX_CAUSE_DEPTH} levels deep. */
  cause?: JsonErrorDocument;
  /** A machine-readable error code, such as `HEROKU_NONINTERACTIVE_LOGIN` or `ENOTFOUND`. */
  code?: string;
  /** The process exit code. Top level only. */
  exitCode?: number;
  /** The API error id, such as `not_found`. */
  id?: string;
  message: string;
  /**
   * The error class name, such as `NotFoundError` or `NonExistentFlagsError`.
   * Informational: the same API failure can have a different name depending on
   * the client that made the request.
   */
  name: string;
  /** The `Request-Id` of a failed API request, for Heroku support. */
  requestId?: string;
  /** The API resource the error is about, such as `app`. */
  resource?: string;
  /** Seconds to wait before retrying a rate-limited request. */
  retryAfter?: number;
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
/** Longest `name`, `code`, `id`, `requestId` or `resource`, in characters. */
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
  http?: {headers?: Record<string, unknown>; statusCode?: unknown};
  id?: unknown;
  message?: unknown;
  name?: unknown;
  resource?: unknown;
  response?: {headers?: {get?: (name: string) => unknown}};
  retryAfter?: unknown;
  statusCode?: unknown;
  suggestions?: unknown;
}

/**
 * The message for a thrown value that isn't an Error: an object's string
 * `message`, a primitive as text, or a fixed message.
 */
function nonErrorMessage(value: unknown): string {
  if (value === undefined || value === null) return 'The command failed without an error message.'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  try {
    const {message} = value as {message?: unknown}
    if (typeof message === 'string') return message
  } catch {}

  return 'The command failed with a value that isn\'t an error.'
}

/** oclif's errors (CLIError, its parse errors) don't set `name`, so fall back to the class name. */
function nameOf(e: Error): unknown {
  return e.name && e.name !== 'Error' ? e.name : e.constructor?.name
}

/** heroku-fetch keeps the fetch Response; http-call keeps the headers on `http`. */
function requestIdOf(e: ErrorFields): unknown {
  return e.response?.headers?.get?.('request-id') ?? e.http?.headers?.['request-id']
}

/** An Error for any thrown value. An Error is returned as is. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(nonErrorMessage(value))
}

export type JsonErrorDocumentOptions = {
  /** The exit code to report. */
  exitCode: number;
  /** Exact values to redact wherever they appear, such as the loaded API token. */
  secrets?: Array<string | undefined>;
}

const credentialScrubber = new Scrubber({patterns: CREDENTIAL_PATTERNS, replacement: REDACTED})

/**
 * Redact secrets from text: each exact value in `secrets` (8 characters or
 * longer, so short values don't redact ordinary words), then js-blanket's
 * `CREDENTIAL_PATTERNS`: Heroku tokens, Authorization header values,
 * `Bearer`/`Basic` credentials, URL passwords and PEM private keys. Patterns
 * can't catch legacy UUID-format tokens, which look like any other id, so
 * callers pass the loaded token as an exact value.
 */
export function redactSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let result = text
  for (const secret of secrets) {
    if (secret && secret.length >= 8) result = result.split(secret).join(REDACTED)
  }

  return credentialScrubber.scrub(result).data
}

/** The full error, stack included, for debug output on stderr. Secrets are redacted. */
export function debugErrorText(err: unknown, secrets: Array<string | undefined> = []): string {
  return redactSecrets(inspect(err, {depth: 2}), secrets)
}

export function toJsonErrorDocument(err: unknown, {exitCode, secrets = []}: JsonErrorDocumentOptions): JsonErrorDocument {
  const text = (value: unknown, max = MAX_SHORT_LENGTH): string | undefined => {
    if (typeof value !== 'string') return undefined
    return truncate(redactSecrets(ansis.strip(value), secrets), max)
  }

  const build = (value: unknown, depth: number, seen: Set<unknown>): JsonErrorDocument => {
    if (!(value instanceof Error)) {
      return {message: text(nonErrorMessage(value), MAX_MESSAGE_LENGTH) ?? '', name: 'Error'}
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
    const document: JsonErrorDocument = {
      message: text(read(() => e.message), MAX_MESSAGE_LENGTH) ?? '',
      name: text(read(() => nameOf(e))) || 'Error',
    }
    const code = text(read(() => e.code))
    const id = text(read(() => e.id ?? e.body?.id))
    const resource = text(read(() => e.resource ?? e.body?.resource))
    const url = text(read(() => e.body?.url), MAX_TEXT_LENGTH)
    const requestId = text(read(() => requestIdOf(e)))
    const retryAfter = read(() => e.retryAfter)
    if (code) document.code = code
    if (typeof statusCode === 'number') document.statusCode = statusCode
    if (requestId) document.requestId = requestId
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) document.retryAfter = retryAfter
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
function fitToLimit(document: JsonErrorDocument): JsonErrorDocument {
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
