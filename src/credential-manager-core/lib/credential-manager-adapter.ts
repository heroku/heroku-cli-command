import {
  type CredentialStore,
  type AuthEntry as ExternalAuthEntry,
  getCredentialHandler,
  getNativeCredentialStore,
  getStorageConfig,
  NativeCredentialNotFoundError,
  NetrcHandler,
} from '@heroku/heroku-credential-manager'
import debug from 'debug'

import {reportCredentialStoreError} from './cli-command-telemetry.js'

const credDebug = debug('heroku-credential-manager')
const SERVICE_NAME = 'heroku-cli'

export async function saveAuth(
  account: string,
  token: string,
  hosts: string[],
  service = SERVICE_NAME,
): Promise<void> {
  const config = getStorageConfig()
  const netrcHandler = new NetrcHandler()
  let nativeSuccess = false

  if (config.credentialStore) {
    try {
      const handler = getCredentialHandler(config.credentialStore)
      handler.saveAuth({account, service, token})
      nativeSuccess = true
    } catch (error) {
      credDebug('native credential store failed during saveAuth; falling back to netrc')
      await reportNativeCredentialStoreError(error, config.credentialStore, 'saveAuth')
    }
  }

  const shouldUseNetrc = config.useNetrc || !nativeSuccess
  if (shouldUseNetrc) {
    await netrcHandler.saveAuthForHosts({login: account, password: token}, hosts)
  } else if (hosts.length > 0) {
    await netrcHandler.removeAuthForHosts(hosts, account)
  }
}

export async function getAuth(
  account: string | undefined,
  host: string,
  service = SERVICE_NAME,
): Promise<ExternalAuthEntry> {
  const config = getStorageConfig()
  const netrcHandler = new NetrcHandler()

  if (account && config.credentialStore) {
    try {
      const handler = getCredentialHandler(config.credentialStore)
      return {account, token: handler.getAuth(account, service)}
    } catch (error) {
      if (!(error instanceof NativeCredentialNotFoundError)) {
        await reportNativeCredentialStoreError(error, config.credentialStore, 'getAuth')
        throw error
      }

      credDebug('native credential was not found during getAuth; falling back to netrc')
    }
  }

  const auth = await netrcHandler.getAuth(host)
  if (auth.login && auth.password) {
    if (account && auth.login !== account) {
      throw new Error('Netrc credential does not match the requested account for host')
    }

    return {account: auth.login, token: auth.password}
  }

  throw new Error('No auth found')
}

export async function listKeychainAccounts(service = SERVICE_NAME): Promise<string[]> {
  const config = getStorageConfig()

  if (config.credentialStore) {
    try {
      return getCredentialHandler(config.credentialStore).listAccounts(service)
    } catch (error) {
      credDebug('native credential store failed during listKeychainAccounts')
      await reportNativeCredentialStoreError(error, config.credentialStore, 'listKeychainAccounts')
    }
  }

  return []
}

export async function removeAuth(
  account: string | undefined,
  hosts: string[],
  service = SERVICE_NAME,
  expectedToken?: string,
): Promise<void> {
  const netrcHandler = new NetrcHandler()
  const nativeStore = getNativeCredentialStore()

  if (nativeStore && account) {
    try {
      const handler = getCredentialHandler(nativeStore)
      if (expectedToken === undefined || handler.getAuth(account, service) === expectedToken) {
        handler.removeAuth(account, service)
      }
    } catch (error) {
      if (!(error instanceof NativeCredentialNotFoundError)) {
        credDebug('native credential store failed during removeAuth; continuing netrc cleanup')
        await reportNativeCredentialStoreError(error, nativeStore, 'removeAuth')
      }
    }
  }

  if (hosts.length > 0) {
    await netrcHandler.removeAuthForHosts(hosts, account, expectedToken)
  }
}

async function reportNativeCredentialStoreError(
  error: unknown,
  credentialStore: CredentialStore,
  operation: 'getAuth' | 'listKeychainAccounts' | 'removeAuth' | 'saveAuth',
): Promise<void> {
  await reportCredentialStoreError(error, {credentialStore, operation})
}
