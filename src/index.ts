export * from './api-client.js'
export {Command, Command as default} from './command.js'
export type * from './completion-types.js'
// Public completion surface: the catalog the host CLI wires by id, plus the two
// cache-key helpers. The individual Completion singletons and internal helpers
// stay module-private — consumers go through `completionCatalog`.
//
// IMPORTANT: this package must resolve to exactly ONE module instance so the host
// CLI and this package share the same Completion object identities (the host keys
// behavior off reference identity). That holds only because package.json has NO
// `exports` field, so the root barrel and any deep import co-resolve to one ESM
// instance. Do not add an `exports` map. (Guarded by test/package-contract.test.ts.)
export {accountCacheKey, completionCatalog, hostCacheKey} from './completions.js'
export {
  getAuth,
  listKeychainAccounts,
  removeAuth,
  saveAuth,
} from './credential-manager-core/lib/credential-manager-adapter.js'
export type {AuthEntry} from './credential-manager-core/lib/types.js'
export * as flags from './flags/index.js'
export * from './git.js'
export {NONINTERACTIVE_LOGIN_ERROR_CODE} from './login.js'
export * from './mutex.js'
export * from './particleboard-client.js'
export * from './prompter.js'
export * from './vars.js'
export * from './yubikey.js'

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
