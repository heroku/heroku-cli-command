/** Backward-compatible shape exported before credential storage was extracted. */
export type AuthEntry = {
  account: string | undefined
  token: string | undefined
}

/** @deprecated Import credential storage types from `@heroku/heroku-credential-manager`. */
/* eslint-disable n/no-extraneous-import */
export type {
  KeychainAuthEntry,
  NetrcAuthEntry,
} from '@heroku/heroku-credential-manager'
/* eslint-enable n/no-extraneous-import */
