import fs from 'node:fs'
import {getCredentialHandler, getStorageConfig} from '../../../src/credential-manager-core/index.js'
import {Netrc} from '../../../src/credential-manager-core/lib/netrc-parser.js'
import {Context} from 'mocha'

export type AcceptanceFixture = {
  account: string,
  hosts: string[],
  service: string,
  token: string,
}

export type NetrcSnapshot = {
  netrcPath: string
  restore: () => void
}

export const HOST_NAME = 'acceptance.test.heroku.com'
export const ALTERNATE_HOST_NAME = 'acceptance.test.alt.heroku.com'
export const SERVICE_NAME = 'heroku-cli-acceptance-test'
export const ALTERNATE_SERVICE_NAME = 'heroku-cli-acceptance-test-alternate'

export const CREDENTIAL_FIXTURES = {
  'account-default': {
    account: 'test@example.com',
    hosts: [HOST_NAME],
    service: SERVICE_NAME,
    token: 'test-token-12345',
  },
  'account-multiple-hosts': {
    account: 'test-multiple-hosts@example.com',
    hosts: [HOST_NAME, ALTERNATE_HOST_NAME],
    service: SERVICE_NAME,
    token: 'test-token-multiple-hosts-12345',
  },
  'account-alternate-service': {
    account: 'test-alternate-service@example.com',
    hosts: [HOST_NAME],
    service: ALTERNATE_SERVICE_NAME,
    token: 'test-token-alternate-service-12345',
  },
} as const satisfies Record<string, AcceptanceFixture>

/**
 * Clears machine entries in the default netrc file between acceptance tests.
 * Keeps the file itself, but removes test host entries to avoid cross-test leakage.
 */
export async function cleanupDefaultNetrc(): Promise<void> {
  let changed = false
  const hosts = getAllAcceptanceHosts()
  const netrc = new Netrc()
  await netrc.load()
  for (const host of hosts) {
    if (netrc.machines[host]) {
      delete netrc.machines[host]
      changed = true
    }
  }

  if (changed) {
    await netrc.save()
  }
}

/**
 * Removes all accounts for the provided test service from the platform-native credential store.
 */
export function cleanupCredentialStore(): void {
  const services = getAllAcceptanceServices()
  for (const service of services) {
  const {handler, accounts} = listCredentialStoreAccounts(service)
  if (!handler) return

  for (const account of accounts) {
    handler.removeAuth(account, service)
  }
}
}

/**
 * Returns all unique hosts referenced by acceptance fixtures.
 */
export function getAllAcceptanceHosts(): string[] {
  return [...new Set(Object.values(CREDENTIAL_FIXTURES).flatMap(fixture => fixture.hosts))]
}

/**
 * Returns all unique services referenced by acceptance fixtures.
 */
export function getAllAcceptanceServices(): string[] {
  return [...new Set(Object.values(CREDENTIAL_FIXTURES).map(fixture => fixture.service))]
}

/**
 * Lists all accounts for the provided test service from the platform-native credential store.
 */
export function listCredentialStoreAccounts(service: string) {
  const {credentialStore} = getStorageConfig()

  if (!credentialStore) return {accounts: []}

  const handler = getCredentialHandler(credentialStore)
  const accounts = handler.listAccounts(service)

  return {handler, accounts}
}

/**
 * Skip the current suite or test unless ACCEPTANCE_TESTS=true.
 */
export function skipUnlessAcceptance(context: Context): void {
  const value = process.env.ACCEPTANCE_TESTS?.trim().toLowerCase()
  if (value !== 'true') {
    context.skip()
  }
}

/**
 * Captures the current netrc file contents and returns a restore callback.
 * If netrc existed, restore writes the original contents back.
 * If netrc did not exist, restore removes any netrc created during the test.
 */
export function snapshotDefaultNetrc(): NetrcSnapshot {
  const netrcPath = new Netrc().file
  const hadExistingFile = fs.existsSync(netrcPath)
  const originalContents = hadExistingFile ? fs.readFileSync(netrcPath) : undefined

  let restored = false

  return {
    netrcPath,
    restore() {
      if (restored) return

      if (hadExistingFile) {
        if (!originalContents) {
          throw new Error(`Original netrc contents were not found for ${netrcPath}`)
        }

        fs.writeFileSync(netrcPath, originalContents)
      } else {
        fs.rmSync(netrcPath, {force: true})
      }

      restored = true
    },
  }
}
