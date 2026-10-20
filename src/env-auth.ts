import {resolveEnvAuth} from '@heroku/heroku-credential-manager'
import {warn as oclifWarn} from '@oclif/core/errors'

/**
 * Resolve an auth token from the process environment, independently of `APIClient`.
 *
 * The *precedence policy* — `HEROKU_API_KEY` provides the token, a bare
 * `HEROKU_API_TOKEN` only yields an advisory warning, an empty key is treated as
 * unset — lives in `@heroku/heroku-credential-manager`'s pure, environment-agnostic
 * `resolveEnvAuth`. This function is only the Node-side adapter around it: it reads
 * `process.env` and routes the advisory warning to the CLI's output. Keeping the
 * policy in the credential manager and the `process.env` read + emission here is the
 * same Node/web split the SDK relies on.
 *
 * @param warn - sink for the advisory warning; defaults to oclif's `warn`. Injectable
 *   so callers (and tests) can capture or suppress it.
 * @returns the environment-provided token, or `undefined` when none is set.
 */
export function resolveEnvToken(warn: (message: string) => void = oclifWarn): string | undefined {
  const {token, warning} = resolveEnvAuth(process.env)
  if (warning) warn(warning.message)
  return token
}
