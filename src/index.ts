import {setCredentialErrorReporter} from '@heroku/heroku-credential-manager'

import {reportCredentialStoreError} from './credential-error-reporter.js'

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
// instance. Do not add an `exports` map. (Guarded by the no-`exports` test in
// test/autocomplete/completion-sources.test.ts.)
export {accountCacheKey, completionCatalog, hostCacheKey} from './completions.js'
export type {AuthEntry} from './credential-manager.js'
export * from './env-auth.js'
export * as flags from './flags/index.js'
export * from './git.js'
export {NONINTERACTIVE_LOGIN_ERROR_CODE} from './login.js'
export * from './mutex.js'
export * from './particleboard-client.js'
export * from './prompter.js'
export * from './vars.js'
export * from './yubikey.js'
export {
  getAuth,
  listKeychainAccounts,
  NativeCredentialNotFoundError,
  removeAuth,
  saveAuth,
} from '@heroku/heroku-credential-manager'

// Register the CLI's credential-error reporter with the published credential
// manager, which invokes it on native credential-store failures. The reporter
// self-gates (no-op in CI/test) and lazily initializes Sentry only on an actual
// failure, so registering eagerly at barrel load is cheap and side-effect-free.
// eslint-disable-next-line unicorn/no-top-level-side-effects -- the reporter must be registered when this package loads; the call is idempotent and gated
setCredentialErrorReporter(reportCredentialStoreError)
