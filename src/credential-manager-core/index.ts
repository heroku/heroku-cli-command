export {
  getAuth,
  listKeychainAccounts,
  removeAuth,
  saveAuth,
} from './lib/credential-manager-adapter.js'
export type {AuthEntry} from './lib/types.js'

/** @deprecated Import credential storage APIs from `@heroku/heroku-credential-manager`. */

export {
  CredentialStore,
  deleteLoginState,
  getCredentialHandler,
  getNativeCredentialStore,
  getStorageConfig,
  type KeychainAuthEntry,
  LinuxHandler,
  type Machines,
  type MachinesWithTokens,
  type MachineToken,
  MacOSHandler,
  NativeCredentialNotFoundError,
  Netrc,
  type NetrcAuthEntry,
  NetrcHandler,
  parse,
  readLoginState,
  type StorageConfig,
  type Token,
  WindowsHandler,
  writeLoginState,
} from '@heroku/heroku-credential-manager'
