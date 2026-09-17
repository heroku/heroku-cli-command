/**
 * Thin wrapper around the credential manager so tests can inject a mock
 * (ESM module exports cannot be stubbed with sinon).
 */
/* eslint-disable n/no-extraneous-import */
import {
  NativeCredentialNotFoundError,
  getAuth as realGetAuth,
  removeAuth as realRemoveAuth,
  saveAuth as realSaveAuth,
} from '@heroku/heroku-credential-manager'

import {reportCredentialStoreError} from './credential-manager-core/lib/cli-command-telemetry.js'
/* eslint-enable n/no-extraneous-import */

/** Backward-compatible shape used by command consumers before storage extraction. */
export type AuthEntry = {
  account: string | undefined
  token: string | undefined
}

export interface CredentialManagerProvider {
  getAuth: (account: string | undefined, host: string, service?: string) => Promise<AuthEntry>
  removeAuth: (account: string | undefined, hosts: string[], service?: string, expectedToken?: string) => Promise<void>
  /** Set for compatibility providers that report their own credential failures. */
  reportsCredentialErrors?: boolean
  saveAuth: (account: string, token: string, hosts: string[], service?: string) => Promise<void>
}

let provider: CredentialManagerProvider = {
  getAuth: realGetAuth,
  removeAuth: realRemoveAuth,
  saveAuth: realSaveAuth,
}

const EXPECTED_MISSING_CREDENTIAL_MESSAGES = new Set([
  'Netrc credential does not match the requested account for host',
  'No auth found',
])

function aggregateErrors(error: AggregateError): undefined | unknown[] {
  try {
    return [...error.errors]
  } catch {
    return undefined
  }
}

function errorMessage(error: Error): string | undefined {
  try {
    return error.message
  } catch {
    return undefined
  }
}

export function credentialServiceForApiHost(apiHost: string): string {
  const normalizedHost = apiHost.toLowerCase()
  return normalizedHost === 'api.heroku.com' ? 'heroku-cli' : `heroku-cli@${normalizedHost}`
}

export function isCredentialNotFoundError(error: unknown, requestedHost?: string): boolean {
  if (error instanceof NativeCredentialNotFoundError) return true
  if (error instanceof AggregateError) {
    const contained = aggregateErrors(error)
    return Boolean(contained?.length && contained.every(item => isCredentialNotFoundError(item, requestedHost)))
  }

  const message = error instanceof Error ? errorMessage(error) : undefined
  return message !== undefined && (
    EXPECTED_MISSING_CREDENTIAL_MESSAGES.has(message)
    || (requestedHost !== undefined && message === `No auth found for ${requestedHost}`)
  )
}

export function setCredentialManagerProvider(p: CredentialManagerProvider): void {
  provider = p
}

export async function getAuth(
  account: string | undefined,
  host: string,
  service?: string,
): Promise<AuthEntry> {
  return reportSurfacedError('getAuth', () => provider.getAuth(account, host, service), host)
}

export async function removeAuth(
  account: string | undefined,
  hosts: string[],
  service?: string,
  expectedToken?: string,
): Promise<void> {
  return reportSurfacedError('removeAuth', () => provider.removeAuth(account, hosts, service, expectedToken))
}

export async function saveAuth(
  account: string,
  token: string,
  hosts: string[],
  service?: string,
): Promise<void> {
  return reportSurfacedError('saveAuth', () => provider.saveAuth(account, token, hosts, service))
}

async function reportSurfacedError<T>(
  operation: 'getAuth' | 'removeAuth' | 'saveAuth',
  action: () => Promise<T>,
  requestedHost?: string,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (!provider.reportsCredentialErrors && !isCredentialNotFoundError(error, requestedHost)) {
      // The external manager intentionally has no telemetry seam and may swallow
      // native fallback failures. Report only errors it surfaces to this facade.
      await reportCredentialStoreError(error, {
        credentialStore: 'unknown',
        operation,
      })
    }

    throw error
  }
}
