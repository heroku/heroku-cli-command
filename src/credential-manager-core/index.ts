import debug from 'debug'

import {LinuxHandler} from './credential-handlers/linux-handler.js'
import {MacOSHandler} from './credential-handlers/macos-handler.js'
import {NetrcHandler} from './credential-handlers/netrc-handler.js'
import {WindowsHandler} from './credential-handlers/windows-handler.js'
import {reportCredentialStoreError} from './lib/cli-command-telemetry.js'
import {CredentialStore, getNativeCredentialStore, getStorageConfig} from './lib/credential-storage-selector.js'
import {AuthEntry, NetrcAuthEntry} from './lib/types.js'

const credDebug = debug('heroku-credential-manager')

const SERVICE_NAME = 'heroku-cli'

/**
 * Saves authentication credentials to the native credential store (if available) or .netrc file.
 *
 * @param account - User's account (email)
 * @param token - Authentication token
 * @param hosts - Hostname(s) for netrc storage (e.g., ['api.heroku.com'])
 * @param service - Service name (defaults to 'heroku-cli')
 * @returns Promise that resolves when credentials are saved
 */
export async function saveAuth(account: string, token: string, hosts: string[], service = SERVICE_NAME): Promise<void> {
  const config = getStorageConfig()
  const netrcHandler = new NetrcHandler()
  let keychainSuccess = false

  if (config.credentialStore) {
    try {
      const handler = getCredentialHandler(config.credentialStore)
      handler.saveAuth({account, service, token})
      keychainSuccess = true
    } catch (error) {
      const {message} = error as Error
      credDebug(message)

      await reportCredentialStoreError(error, {
        credentialStore: config.credentialStore,
        operation: 'saveAuth',
      })
    }
  }

  const shouldUseNetrc = config.useNetrc || !keychainSuccess
  if (shouldUseNetrc && hosts.length > 0) {
    const netrcAuth: NetrcAuthEntry = {
      login: account,
      password: token,
    }
    await netrcHandler.saveAuthForHosts(netrcAuth, hosts)
  }
}

/**
 * Retrieves authentication credentials from the native credential store (if available) or .netrc file.
 *
 * @param account - User's account (email), or undefined to search for account
 * @param host - Hostname for netrc lookup (e.g., 'api.heroku.com')
 * @param service - Service name (defaults to 'heroku-cli')
 * @returns Promise that resolves with the authentication account and token.
 * @throws Error if no credentials are found in either location.
 */
export async function getAuth(account: string | undefined, host: string, service = SERVICE_NAME): Promise<AuthEntry> {
  const config = getStorageConfig()
  const netrcHandler = new NetrcHandler()
  let keychainSuccess = false

  if (config.credentialStore && account) {
    try {
      const handler = getCredentialHandler(config.credentialStore)
      const token = handler.getAuth(account, service)
      keychainSuccess = true
      return {account, token}
    } catch (error) {
      const {message} = error as Error
      credDebug(message)

      await reportCredentialStoreError(error, {
        credentialStore: config.credentialStore,
        operation: 'getAuth',
      })
    }
  }

  const shouldUseNetrc = config.useNetrc || !keychainSuccess
  if (shouldUseNetrc) {
    const auth = await netrcHandler.getAuth(host)

    if (auth.password) {
      return {account: auth.login, token: auth.password}
    }
  }

  throw new Error('No auth found')
}

/**
 * Lists all accounts stored in the native credential store for a given service.
 *
 * @param service - Service name (defaults to 'heroku-cli')
 * @returns Array of account names, or empty array if no native credential store is available
 */
export async function listKeychainAccounts(service = SERVICE_NAME): Promise<string[]> {
  const config = getStorageConfig()

  if (config.credentialStore) {
    try {
      const handler = getCredentialHandler(config.credentialStore)
      return handler.listAccounts(service)
    } catch (error) {
      const {message} = error as Error
      credDebug(message)

      await reportCredentialStoreError(error, {
        credentialStore: config.credentialStore,
        operation: 'listKeychainAccounts',
      })

      return []
    }
  }

  return []
}

/**
 * Removes authentication credentials from the platform native store (when present) and .netrc.
 * Always attempts to remove from both stores to prevent stale tokens when users switch between modes.
 *
 * @param account - User's account (email), or undefined when using HEROKU_API_KEY only (native removal is skipped)
 * @param hosts - Hostname(s) for netrc storage (e.g., ['api.heroku.com'])
 * @param service - Service name (defaults to 'heroku-cli')
 * @returns Promise that resolves when credentials are removed
 */
export async function removeAuth(account: string | undefined, hosts: string[], service = SERVICE_NAME): Promise<void> {
  const netrcHandler = new NetrcHandler()
  const nativeStore = getNativeCredentialStore()

  if (nativeStore && account) {
    try {
      const handler = getCredentialHandler(nativeStore)
      handler.removeAuth(account, service)
    } catch (error) {
      const {message} = error as Error
      credDebug(message)

      await reportCredentialStoreError(error, {
        credentialStore: nativeStore,
        operation: 'removeAuth',
      })
    }
  }

  if (hosts.length > 0) {
    await netrcHandler.removeAuthForHosts(hosts)
  }
}

/**
 * Factory function to create the appropriate credential handler based on platform.
 * @private
 * @param store - The type of credential store to use
 * @returns A handler instance for the specified store
 */
export function getCredentialHandler(store: CredentialStore) {
  switch (store) {
    case CredentialStore.LinuxSecretService: {
      return new LinuxHandler()
    }

    case CredentialStore.MacOSKeychain: {
      return new MacOSHandler()
    }

    case CredentialStore.WindowsCredentialManager: {
      return new WindowsHandler()
    }
  }
}

export {LinuxHandler} from './credential-handlers/linux-handler.js'
export {MacOSHandler} from './credential-handlers/macos-handler.js'
export {NetrcHandler} from './credential-handlers/netrc-handler.js'
export {WindowsHandler} from './credential-handlers/windows-handler.js'
export {CredentialStore, getNativeCredentialStore, getStorageConfig} from './lib/credential-storage-selector.js'
export type {StorageConfig} from './lib/credential-storage-selector.js'
export {deleteLoginState, readLoginState, writeLoginState} from './lib/login-state.js'
export {Netrc, parse} from './lib/netrc-parser.js'
export type {
  Machines,
  MachinesWithTokens,
  MachineToken,
  Token,
} from './lib/netrc-parser.js'
export type {AuthEntry, KeychainAuthEntry, NetrcAuthEntry} from './lib/types.js'
