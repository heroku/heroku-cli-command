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
      const output = childProcess.execSync(
        `secret-tool search --all service "${service}"`,
        {encoding: 'utf8'},
      )
      console.log('=== list accounts output ===')
      console.log('---RAW START---')
      console.log(JSON.stringify(output))
      console.log('---RAW END---')
      // Expected output format:
      // [/org/freedesktop/secrets/collection/login/###]
      // label = Label Name
      // secret = secret-value
      // created = 2024-01-01 12:00:00
      // modified = 2024-01-01 12:00:00
      // schema = org.freedesktop.Secret.Generic
      // attribute.service = heroku-cli
      // attribute.account = user@example.com
      // (blank line between entries)

      const accounts: string[] = []
      const lines = output.split('\n')

      for (const line of lines) {
        if (line.startsWith('attribute.account = ')) {
          const account = line.slice('attribute.account = '.length).trim()
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
    try {
      childProcess.execSync(
        `secret-tool clear service "${service}" account "${account}"`,
        {encoding: 'utf8'},
      )
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to remove token from Linux keyring: ${this.scrubError(message)}`)
    }
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
