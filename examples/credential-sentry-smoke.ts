/**
 * Manual Sentry validation for native credential-store errors (`heroku-cli-command`).
 *
 * This calls `getAuth` with an account that is unlikely to exist in the OS store, so the
 * macOS / Linux / Windows handler typically throws; the error is caught in
 * credential-manager-core, reported to Sentry (when allowed), then the flow may fall back to netrc.
 *
 * Environment — reporting must be allowed (not CI / test runs):
 * - `unset CI IS_HEROKU_TEST_ENV`
 * - `export NODE_ENV=development` (must not be `test`)
 * - `unset DISABLE_TELEMETRY`
 *
 * Run from repo root:
 * - `./examples/run.sh credential-sentry-smoke`
 * - Optional: `./examples/run.sh credential-sentry-smoke you@example.com`
 *
 * In Sentry, filter by tag `component:heroku-cli-command` (and `credential_operation:getAuth`).
 */

import {getAuth} from '../src/credential-manager-core/index.js'

const account = process.argv[2] ?? 'nonexistent-sentry-smoke@example.com'

try {
  await getAuth(account, 'api.heroku.com')
  console.log('getAuth resolved (e.g. netrc fallback). If the native store failed first, check Sentry for component=heroku-cli-command.')
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
}
