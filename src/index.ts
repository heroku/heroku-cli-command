export * from './api-client.js'
export {Command, Command as default} from './command.js'
export * from './completions.js'
export type {AuthEntry} from './credential-manager-core/lib/types.js'
export * as flags from './flags/index.js'
export * from './git.js'
export * from './mutex.js'
export * from './particleboard-client.js'
export * from './prompter.js'
export * from './vars.js'
export * from './yubikey.js'

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
