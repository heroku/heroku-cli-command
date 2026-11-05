import {Scrubber} from '@heroku/js-blanket'
import childProcess from 'node:child_process'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {KeychainAuthEntry} from '../lib/types.js'

const SEARCH_TIMEOUT_MS = 5000
const SEARCH_MAX_BUFFER = 1024
const LOOKUP_MAX_BUFFER = 1024 * 1024
const SEARCH_HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'linux-keyring-search.mjs')
const CHILD_ENV_KEYS = [
  'PATH',
  'HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'DBUS_STARTER_ADDRESS',
  'DBUS_STARTER_BUS_TYPE',
] as const

export function createChildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }

  env.LC_ALL = 'C'
  return env
}

/**
 * Handles credentials in the Linux Secret Service.
 * Uses D-Bus for metadata searches and secret-tool (libsecret) to retrieve and mutate secrets.
 */
export class LinuxHandler {
  private readonly scrubber = new Scrubber({
    patterns: [
      /\baccount\s+(?:"[^"]*"|[^\r\n]+)/g,  // Scrub account value
    ],
  })

  /**
   * Retrieves the authentication token from the Linux keyring.
   * @param account - The account login to use (e.g. 'test@example.com')
   * @param service - The service name to use
   * @returns The stored authentication token.
   * @throws Error if searching or retrieving the token fails, or no matching item exists.
   */
  public getAuth(account: string, service: string): string {
    const token = this.getAuthIfAvailable(account, service)
    if (token === undefined) {
      throw new Error('No credentials found')
    }

    return token
  }

  /**
   * Retrieves the authentication token from the Linux keyring when a matching item exists.
   * @param account - The account login to use (e.g. 'test@example.com')
   * @param service - The service name to use
   * @returns The stored authentication token, or undefined if no matching item exists.
   * @throws Error if searching or retrieving the token fails.
   */
  public getAuthIfAvailable(account: string, service: string): string | undefined {
    let searchResult: string
    const env = createChildEnvironment()

    try {
      searchResult = childProcess.execFileSync(
        process.execPath,
        [SEARCH_HELPER_PATH],
        {
          encoding: 'utf8',
          env,
          input: JSON.stringify({account, service}),
          killSignal: 'SIGKILL',
          maxBuffer: SEARCH_MAX_BUFFER,
          stdio: ['pipe', 'pipe', 'ignore'],
          timeout: SEARCH_TIMEOUT_MS,
        },
      )
    } catch {
      throw new Error('Failed to search Linux keyring')
    }

    let parsedResult: unknown
    try {
      parsedResult = JSON.parse(searchResult)
    } catch {
      throw new Error('Failed to search Linux keyring')
    }

    if (!parsedResult || typeof parsedResult !== 'object' || Array.isArray(parsedResult)
      || Object.getPrototypeOf(parsedResult) !== Object.prototype) {
      throw new Error('Failed to search Linux keyring')
    }

    const resultKeys = Reflect.ownKeys(parsedResult)
    if (resultKeys.length !== 1 || resultKeys[0] !== 'status') {
      throw new Error('Failed to search Linux keyring')
    }

    const {status} = parsedResult as {status?: unknown}
    if ((status !== 'locked-match' && status !== 'match' && status !== 'no-match')
      // Re-serialization rejects duplicate keys, whitespace, and any non-compact representation.
      || JSON.stringify(parsedResult) !== searchResult) {
      throw new Error('Failed to search Linux keyring')
    }

    if (status === 'no-match') {
      return undefined
    }

    if (status === 'locked-match') {
      throw new Error('Failed to retrieve token from Linux keyring: keyring is locked')
    }

    try {
      const output = childProcess.execFileSync(
        'secret-tool',
        ['lookup', 'service', service, 'account', account],
        {
          encoding: 'utf8',
          env,
          killSignal: 'SIGKILL',
          maxBuffer: LOOKUP_MAX_BUFFER,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: SEARCH_TIMEOUT_MS,
        },
      )
      const token = output.trim()

      if (!token) {
        throw new Error('Token not found')
      }

      return token
    } catch {
      throw new Error('Failed to retrieve token from Linux keyring')
    }
  }

  /**
   * Lists all accounts stored in the Linux keyring for a given service.
   * @param service - The service name to search for
   * @returns Array of account names found for the service
   * @throws Error if the search operation fails
   */
  public listAccounts(service: string): string[] {
    try {
      const spawnResult = childProcess.spawnSync(
        'secret-tool',
        ['search', '--all', 'service', service],
        {encoding: 'utf8', env: createChildEnvironment()},
      )

      if (spawnResult.error) {
        throw spawnResult.error
      }

      if (spawnResult.status !== 0) {
        const stderr = spawnResult.stderr || 'Unknown error'
        throw new Error(stderr)
      }

      /*
       * Expected output format:
       * stdout: label, secret, created, modified, schema lines
       * stderr: attribute.service / attribute.account lines
       */

      const accounts: string[] = []
      const lines = (spawnResult.stderr ?? '').split('\n')

      for (const line of lines) {
        const match = line.trim().match(/^attribute\.account\s*=\s*(.+)$/)
        if (match) {
          const account = match[1].trim()
          if (account) {
            accounts.push(account)
          }
        }
      }

      return accounts
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to list accounts in Linux keyring: ${this.scrubError(message)}`)
    }
  }

  /**
   * Removes the authentication token from the Linux keyring.
   * @param account - The account login to use (e.g. 'test@example.com')
   * @param service - The service name to use
   * @returns void
   * @throws Error if the removal operation fails.
   */
  public removeAuth(account: string, service: string): void {
    const spawnResult = childProcess.spawnSync(
      'secret-tool',
      ['clear', 'service', service, 'account', account],
      {encoding: 'utf8', env: createChildEnvironment()},
    )

    if (spawnResult.error) {
      const {message} = spawnResult.error
      throw new Error(`Failed to remove token from Linux keyring: ${this.scrubError(message)}`)
    }

    if (spawnResult.status === 0) {
      return
    }

    const status = spawnResult.status ?? -1

    const stderr = (spawnResult.stderr ?? '').toString()
    if (this.isMissingSecretClearFailure(status, stderr)) {
      return
    }

    throw new Error(`Failed to remove token from Linux keyring: ${this.scrubError(stderr || `exit ${status}`)}`)
  }

  /**
   * Saves an authentication entry to the Linux keyring.
   * If a credential with the same attributes already exists, it is updated with the new token.
   * @param auth - The authentication entry containing account and token information to store.
   * @returns void
   * @throws Error if the save operation fails.
   */
  public saveAuth(auth: KeychainAuthEntry): void {
    try {
      const spawnResult = childProcess.spawnSync(
        'secret-tool',
        [
          'store',
          '--label=Heroku CLI',
          'service',
          auth.service,
          'account',
          auth.account,
        ],
        {
          encoding: 'utf8',
          env: createChildEnvironment(),
          input: auth.token,
        },
      )

      if (spawnResult.error) {
        throw spawnResult.error
      }

      if (spawnResult.status !== 0) {
        const stderr = spawnResult.stderr || 'Unknown error'
        throw new Error(stderr)
      }
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to store token in Linux keyring: ${this.scrubError(message)}`)
    }
  }

  /**
   * secret-tool clear fails when no matching credential exists; treat as successful no-op for logout.
   */
  private isMissingSecretClearFailure(status: number, stderr: string): boolean {
    if (status === 0) {
      return false
    }

    // secret-tool clear exits 1 with no output when nothing matched (locale-independent).
    if (status === 1 && stderr.trim() === '') {
      return true
    }

    const text = stderr.toLowerCase()
    return /no matching|could not find|not found|unknown attribute|does not exist|cannot remove/i.test(text)
  }

  /**
   * Scrubs account names and passwords/tokens from error messages.
   *
   * @param message - The error message to scrub
   * @returns The scrubbed error message with sensitive data replaced by "[SCRUBBED]"
   */
  private scrubError(message: string): string {
    const result = this.scrubber.scrub({message})
    return result.data.message
  }
}
