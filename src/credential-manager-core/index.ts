export type {AuthEntry} from './lib/types.js'

/** @deprecated Import credential storage APIs from `@heroku/heroku-credential-manager`. */
/* eslint-disable n/no-extraneous-import */
export {
  CredentialStore,
  deleteLoginState,
  getAuth,
  getCredentialHandler,
  getNativeCredentialStore,
  getStorageConfig,
  type KeychainAuthEntry,
  LinuxHandler,
  listKeychainAccounts,
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
  removeAuth,
  saveAuth,
  type StorageConfig,
  type Token,
  WindowsHandler,
  writeLoginState,
} from '@heroku/heroku-credential-manager'
/* eslint-enable n/no-extraneous-import */
