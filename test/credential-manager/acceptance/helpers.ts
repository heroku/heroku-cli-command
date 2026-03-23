import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOST_NAME = 'acceptance.test.heroku.com'
export const ALTERNATE_HOST_NAME = 'acceptance-2.test.heroku.com'

export const SERVICE_NAME = 'heroku-cli-acceptance-test'
export const ALTERNATE_SERVICE_NAME = 'heroku-cli-acceptance-test-2'

export type Fixture = {
  account: string,
  hosts: string[],
  service: string,
  token: string,
}

export const CREDENTIAL_FIXTURES: Record<string, Fixture> = {
  'account-default': {
    account: 'acceptance-test@example.com',
    hosts: [HOST_NAME],
    service: SERVICE_NAME,
    token: 'test-acceptance-token-12345',
  },
  'account-different-service': {
    account: 'acceptance-test-different-service@example.com',
    hosts: [HOST_NAME],
    service: ALTERNATE_SERVICE_NAME,
    token: 'test-acceptance-token-12348',
  },
  'account-multiple-hosts': {
    account: 'acceptance-test-multiple-hosts@example.com',
    hosts: [HOST_NAME, ALTERNATE_HOST_NAME],
    service: SERVICE_NAME,
    token: 'test-acceptance-token-12347',
  },
} as const satisfies Record<string, Fixture>

/**
 * Skip the current suite or test unless ACCEPTANCE_TESTS=true.
 */
export function skipUnlessAcceptanceEnv(context: Mocha.Context): void {
  const value = process.env.ACCEPTANCE_TESTS?.toLowerCase()
  if (value !== 'true') {
    context.skip()
  }
}

/**
 * Result of setting up a temp directory for netrc-only acceptance tests.
 * Call restore() in afterEach/after to reset env and remove the directory.
 */
export type TempNetrcDir = {
  dir: string
  restore: () => void
}

/**
 * Creates a temp directory and sets HOME (and on Windows, USERPROFILE) so that
 * .netrc reads/writes go to the temp dir.
 */
export function setupTempNetrcDir(): TempNetrcDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heroku-credential-manager-acceptance-'))
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE

  process.env.HOME = dir
  if (process.platform === 'win32') {
    process.env.USERPROFILE = dir
  }

  return {
    dir,
    restore() {
      process.env.HOME = originalHome
      if (process.platform === 'win32') {
        process.env.USERPROFILE = originalUserProfile
      }

      try {
        fs.rmSync(dir, {force: true, recursive: true})
      } catch {
        // ignore cleanup errors
      }
    },
  }
}
