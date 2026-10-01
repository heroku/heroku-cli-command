/** Backward-compatible shape exported before credential storage was extracted. */
export type AuthEntry = {
  account: string | undefined
  token: string | undefined
}

/** @deprecated Import credential storage types from `@heroku/heroku-credential-manager`. */

export type {
  KeychainAuthEntry,
  NetrcAuthEntry,
} from '@heroku/heroku-credential-manager'
