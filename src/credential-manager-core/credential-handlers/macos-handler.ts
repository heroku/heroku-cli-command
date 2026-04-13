import {Scrubber} from '@heroku/js-blanket'
import childProcess from 'node:child_process'

import {KeychainAuthEntry} from '../lib/types.js'

/**
 * Handles credential storage, removal, and retrieval using the macOS Keychain.
 * Uses the macOS security command-line tool to interact with the Keychain.
 */
export class MacOSHandler {
  private readonly scrubber = new Scrubber({
    patterns: [
      /-a\s+"[^"]*"/g, // Scrub account (-a flag)
      /-w\s+"[^"]*"/g, // Scrub password/token (-w flag)
    ],
  })

  /**
   * Retrieves the authentication token from macOS Keychain.
   * @param account - The account login to use (e.g. 'test@example.com')
   * @param service - The service name to use
   * @returns The stored authentication token.
   * @throws Error if the token is not found or retrieval fails.
   */
  public getAuth(account: string, service: string): string {
    try {
      const output = childProcess.execSync(
        `security find-generic-password -a "${account}" -s "${service}" -w`,
        {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      )
      const token = output.trim()

      if (!token) {
        throw new Error('Token not found')
      }

      return token
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to retrieve token from macOS Keychain: ${this.scrubError(message)}`)
    }
  }

  /**
   * Lists all accounts stored in macOS Keychain for a given service.
   * @param service - The service name to search for
   * @returns Array of account names found for the service
   * @throws Error if the search operation fails
   */
  public listAccounts(service: string): string[] {
    try {
      const output = childProcess.execSync(
        'security dump-keychain',
        {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      )

      // Expected output format:
      // keychain: "/path/to/keychain"
      // version: 512
      // class: "genp"
      // attributes:
      //     0x00000007 <blob>="service-name"
      //     "acct"<blob>="account-name"
      //     "svce"<blob>="service-name"
      //     ...

      const accounts: string[] = []

      // Split by keychain entry boundaries
      const entries = output.split(/^keychain:/m)

      for (const entry of entries) {
        // Only process generic password entries
        if (!entry.includes('class: "genp"')) continue

        // Extract service name
        const serviceMatch = entry.match(/"svce"<blob>="([^"]+)"/)
        if (!serviceMatch || serviceMatch[1] !== service) continue

        // Extract account name
        const accountMatch = entry.match(/"acct"<blob>="([^"]+)"/)
        if (accountMatch) {
          accounts.push(accountMatch[1])
        }
      }

      return accounts
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to list accounts in macOS Keychain: ${this.scrubError(message)}`)
    }
  }

  /**
   * Removes the authentication token from macOS Keychain.
   * @param account - The account login to use (e.g. 'test@example.com')
   * @param service - The service name to use
   * @returns void
   * @throws Error if the removal operation fails.
   */
  public removeAuth(account: string, service: string): void {
    try {
      childProcess.execSync(
        `security delete-generic-password -a "${account}" -s "${service}"`,
        {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      )
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to remove token from macOS Keychain: ${this.scrubError(message)}`)
    }
  }

  /**
   * Saves an authentication entry to macOS Keychain.
   * If a credential with the same name already exists, it is updated with the new token.
   * @param auth - The authentication entry containing account and token information to store.
   * @returns void
   * @throws Error if the save operation fails.
   */
  public saveAuth(auth: KeychainAuthEntry): void {
    try {
      childProcess.execSync(
        `security add-generic-password -U -a "${auth.account}" -s "${auth.service}" -w "${auth.token}"`,
        {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      )
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to store token in macOS Keychain: ${this.scrubError(message)}`)
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
