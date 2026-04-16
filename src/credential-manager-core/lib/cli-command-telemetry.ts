import type {ErrorEvent, ExclusiveEventHintOrCaptureContext, NodeOptions} from '@sentry/node'

import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import type {CredentialStore} from './credential-storage-selector.js'

const DSN
  = 'https://4eb3812769d649a09ae76ef3fcd03dbb@o4508609692368896.ingest.us.sentry.io/4511095245832192'

/** Indirection so tests can `sinon.stub` without stubbing the ESM `@sentry/node` namespace. */
export const credentialSentrySdk = {
  async captureException(error: unknown, options?: ExclusiveEventHintOrCaptureContext) {
    const Sentry = await import('@sentry/node')
    return Sentry.captureException(error, options)
  },
  async flush(timeout?: number) {
    const Sentry = await import('@sentry/node')
    return Sentry.flush(timeout)
  },
  async getClient() {
    const Sentry = await import('@sentry/node')
    return Sentry.getClient()
  },
  async init(options: NodeOptions) {
    const Sentry = await import('@sentry/node')
    return Sentry.init(options)
  },
}

let releaseCache: string | undefined
let sentryInitialized = false

function readPackageVersion(): string {
  if (releaseCache !== undefined) {
    return releaseCache
  }

  const dir = dirname(fileURLToPath(import.meta.url))
  const pkgPath = join(dir, '../../../package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {version?: string}
  releaseCache = pkg.version ?? 'unknown'
  return releaseCache
}

export function shouldReportCredentialErrorsToSentry(): boolean {
  if (process.env.CI === 'true') {
    return false
  }

  if (process.env.NODE_ENV === 'test') {
    return false
  }

  if (process.env.IS_HEROKU_TEST_ENV === 'true') {
    return false
  }

  if (process.env.DISABLE_TELEMETRY === 'true') {
    return false
  }

  return true
}

async function ensureCredentialSentryInitialized(): Promise<void> {
  if (!shouldReportCredentialErrorsToSentry()) {
    return
  }

  if (sentryInitialized) {
    return
  }

  const existingClient = await credentialSentrySdk.getClient()
  if (existingClient) {
    sentryInitialized = true
    return
  }

  // Lazy load dependencies only when we need to report an error
  const {
    GDPR_FIELDS,
    HEROKU_FIELDS,
    PCI_FIELDS,
    PII_PATTERNS,
    Scrubber,
  } = await import('@heroku/js-blanket')

  const scrubber = new Scrubber({
    fields: [...HEROKU_FIELDS, ...GDPR_FIELDS, ...PCI_FIELDS],
    patterns: [...PII_PATTERNS],
  })

  const isDev = process.env.IS_DEV_ENVIRONMENT === 'true'

  await credentialSentrySdk.init({
    beforeSend(event: ErrorEvent) {
      const scrubbed
        = scrubber.scrub(event as unknown as Record<string, unknown>).data
      return scrubbed as unknown as ErrorEvent
    },
    dsn: DSN,
    environment: isDev ? 'development' : 'production',
    release: `@heroku-cli/command@${readPackageVersion()}`,
    skipOpenTelemetrySetup: true,
  })

  sentryInitialized = true
}

export type CredentialSentryOperation = 'getAuth' | 'removeAuth' | 'saveAuth'

export async function reportCredentialStoreError(
  error: unknown,
  context: {credentialStore: CredentialStore; operation: CredentialSentryOperation},
): Promise<void> {
  if (!shouldReportCredentialErrorsToSentry()) {
    return
  }

  try {
    await ensureCredentialSentryInitialized()
    await credentialSentrySdk.captureException(error, {
      tags: {
        component: 'heroku-cli-command',
        credential_operation: context.operation,
        credential_store: context.credentialStore,
      },
    })
    await credentialSentrySdk.flush(2000)
  } catch {
    // avoid impacting credential flows if Sentry fails
  }
}
