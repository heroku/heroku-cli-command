import {
  GDPR_FIELDS,
  HEROKU_FIELDS,
  PCI_FIELDS,
  PII_PATTERNS,
  Scrubber,
} from '@heroku/js-blanket'
import type {ErrorEvent} from '@sentry/node'
import * as Sentry from '@sentry/node'
import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import type {CredentialStore} from './credential-storage-selector.js'

const DSN
  = 'https://76530569188e7ee2961373f37951d916@o4508609692368896.ingest.us.sentry.io/4508767754846208'

const scrubber = new Scrubber({
  fields: [...HEROKU_FIELDS, ...GDPR_FIELDS, ...PCI_FIELDS],
  patterns: [...PII_PATTERNS],
})

/** Indirection so tests can `sinon.stub` without stubbing the ESM `@sentry/node` namespace. */
export const credentialSentrySdk = {
  captureException: Sentry.captureException.bind(Sentry),
  flush: Sentry.flush.bind(Sentry),
  getClient: Sentry.getClient.bind(Sentry),
  init: Sentry.init.bind(Sentry),
}

let releaseCache: string | undefined

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

function ensureCredentialSentryInitialized(): void {
  if (!shouldReportCredentialErrorsToSentry()) {
    return
  }

  if (credentialSentrySdk.getClient()) {
    return
  }

  const isDev = process.env.IS_DEV_ENVIRONMENT === 'true'

  credentialSentrySdk.init({
    beforeSend(event) {
      const scrubbed
        = scrubber.scrub(event as unknown as Record<string, unknown>).data
      return scrubbed as unknown as ErrorEvent
    },
    dsn: DSN,
    environment: isDev ? 'development' : 'production',
    release: `@heroku-cli/command@${readPackageVersion()}`,
    skipOpenTelemetrySetup: true,
  })
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
    ensureCredentialSentryInitialized()
    credentialSentrySdk.captureException(error, {
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
