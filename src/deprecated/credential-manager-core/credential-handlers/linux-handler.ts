import {Scrubber} from '@heroku/js-blanket'
import childProcess from 'node:child_process'

import {KeychainAuthEntry} from '../lib/types.js'

/**
 * Handles credential storage, removal, and retrieval using the Linux Secret Service API.
 * Uses the secret-tool command-line utility (part of libsecret) to interact with desktop keyrings.
 */
export class LinuxHandler {
  private readonly scrubber = new Scrubber({
    patterns: [
      /account\s+"[^"]*"/g,  // Scrub account value
    ],
  })

  /**
   * Retrieves the authentication token from the Linux keyring.
   * @param account - The account login to use (e.g. 'test@example.com')
   * @param service - The service name to use
   * @returns The stored authentication token.
   * @throws Error if the token is not found or retrieval fails.
   */
  public getAuth(account: string, service: string): string {
    try {
      const output = childProcess.execSync(
        `secret-tool lookup service "${service}" account "${account}"`,
        {encoding: 'utf8'},
      )
      const token = output.trim()

      if (!token) {
        throw new Error('Token not found')
      }

      return token
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to retrieve token from Linux keyring: ${this.scrubError(message)}`)
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
        {encoding: 'utf8'},
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
      {encoding: 'utf8', env: {...process.env, LC_ALL: 'C'}},
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
