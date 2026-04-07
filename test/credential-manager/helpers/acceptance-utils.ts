import {Context} from 'mocha'
import {execSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {getCredentialHandler, getStorageConfig} from '../../../src/credential-manager-core/index.js'
import {Netrc} from '../../../src/credential-manager-core/lib/netrc-parser.js'

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
  'account-alternate-service': {
    account: 'test-alternate-service@example.com',
    hosts: [HOST_NAME],
    service: ALTERNATE_SERVICE_NAME,
    token: 'test-token-alternate-service-12345',
  },
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
    const {accounts, handler} = listCredentialStoreAccounts(service)
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

  return {accounts, handler}
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

export type FakeCredentialStoreSetup = {
  cleanup: () => void
  originalPath: string
  tmpDir: string
}

/**
 * Creates a fake credential store command that always fails.
 * Used for testing credential store fallback behavior.
 *
 * The fake command is placed in a temporary directory that is prepended to PATH,
 * ensuring it's found before the real command.
 *
 * @param commandName - The command to fake (e.g., 'secret-tool', 'security', 'powershell')
 * @param scriptContent - The script content for the fake command
 * @returns An object with the original PATH and a cleanup function to restore state
 */
function setupFakeCommand(commandName: string, scriptContent: string): FakeCredentialStoreSetup {
  // Create a temporary directory for our fake command
  const tmpPrefix = process.platform === 'win32' ? process.env.TEMP || String.raw`C:\temp` : '/tmp'
  const tmpDir = fs.mkdtempSync(path.join(tmpPrefix, 'keyring-test-'))
  const fakeCommand = path.join(tmpDir, commandName)

  // Create a fake command that always fails
  fs.writeFileSync(fakeCommand, scriptContent, {mode: 0o755})

  // Prepend our temp directory to PATH so our fake command is found first
  const originalPath = process.env.PATH || ''
  const pathSeparator = process.platform === 'win32' ? ';' : ':'
  process.env.PATH = `${tmpDir}${pathSeparator}${originalPath}`

  return {
    cleanup() {
      // Restore PATH
      process.env.PATH = originalPath

      // Remove temporary directory
      try {
        fs.rmSync(tmpDir, {force: true, recursive: true})
      } catch {
        // Best effort cleanup
      }
    },
    originalPath,
    tmpDir,
  }
}

/**
 * Creates a fake secret-tool executable that always fails.
 * Used for testing credential store fallback behavior on Linux.
 *
 * The fake secret-tool is placed in a temporary directory that is prepended to PATH,
 * ensuring it's found before the real secret-tool.
 *
 * @returns An object with the original PATH and a cleanup function to restore state
 */
export function setupFakeSecretTool(): FakeCredentialStoreSetup {
  return setupFakeCommand('secret-tool', '#!/bin/bash\nexit 1\n')
}

/**
 * Creates a fake security command that always fails.
 * Used for testing credential store fallback behavior on macOS.
 *
 * The fake security command is placed in a temporary directory that is prepended to PATH,
 * ensuring it's found before the real security command.
 *
 * @returns An object with the original PATH and a cleanup function to restore state
 */
export function setupFakeSecurity(): FakeCredentialStoreSetup {
  return setupFakeCommand('security', '#!/bin/bash\nexit 1\n')
}

/**
 * Creates a fake powershell command that always fails.
 * Used for testing credential store fallback behavior on Windows.
 *
 * The fake powershell command is placed in a temporary directory that is prepended to PATH,
 * ensuring it's found before the real powershell command.
 *
 * @returns An object with the original PATH and a cleanup function to restore state
 */
export function setupFakePowerShell(): FakeCredentialStoreSetup {
  const scriptContent = process.platform === 'win32'
    ? '@echo off\r\nexit /b 1\r\n'
    : '#!/bin/bash\nexit 1\n'

  const commandName = process.platform === 'win32' ? 'powershell.exe' : 'powershell'
  return setupFakeCommand(commandName, scriptContent)
}

/**
 * Sets up a fake credential store command appropriate for the current platform.
 * - Linux: fake secret-tool
 * - macOS: fake security
 * - Windows: fake powershell
 *
 * @returns An object with the original PATH and a cleanup function to restore state, or undefined if platform is not supported
 */
export function setupFakeCredentialStore(): FakeCredentialStoreSetup | undefined {
  switch (process.platform) {
    case 'darwin': {
      if (!isSecurityAvailable()) return undefined
      return setupFakeSecurity()
    }

    case 'linux': {
      if (!isSecretToolAvailable()) return undefined
      return setupFakeSecretTool()
    }

    case 'win32': {
      if (!isPowerShellAvailable()) return undefined
      return setupFakePowerShell()
    }

    default: {
      return undefined
    }
  }
}

/**
 * Checks if secret-tool is available on the system.
 * @returns true if secret-tool is available, false otherwise
 */
export function isSecretToolAvailable(): boolean {
  try {
    execSync('which secret-tool', {encoding: 'utf8', stdio: 'pipe'})
    return true
  } catch {
    return false
  }
}

/**
 * Checks if security command is available on the system (macOS).
 * @returns true if security is available, false otherwise
 */
export function isSecurityAvailable(): boolean {
  try {
    execSync('which security', {encoding: 'utf8', stdio: 'pipe'})
    return true
  } catch {
    return false
  }
}

/**
 * Checks if powershell is available on the system (Windows).
 * @returns true if powershell is available, false otherwise
 */
export function isPowerShellAvailable(): boolean {
  try {
    const command = process.platform === 'win32' ? 'where powershell' : 'which powershell'
    execSync(command, {encoding: 'utf8', stdio: 'pipe'})
    return true
  } catch {
    return false
  }
}
