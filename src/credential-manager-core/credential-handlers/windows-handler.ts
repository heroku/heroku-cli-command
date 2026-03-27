import {Scrubber} from '@heroku/js-blanket'
import childProcess from 'node:child_process'

import {KeychainAuthEntry} from '../lib/types.js'

/**
 * Handles credential storage and retrieval using the Windows Credential Manager.
 * Uses PowerShell commands to interact with the Windows.Security.Credentials.PasswordVault API.
 */
export class WindowsHandler {
  private readonly scrubber = new Scrubber({
    patterns: [
      /Retrieve\("([^"]+)",\s*"([^"]+)"\)/g, // Scrub account in Retrieve("service", "account")
      /PasswordCredential\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\)/g, // Scrub account and token in PasswordCredential
    ],
  })

  /**
   * Retrieves the authentication token from Windows Credential Manager.
   * @param account - The account login to use (e.g. 'test@example.com')
   * @param service - The service name to use
   * @returns The stored authentication token.
   * @throws Error if the token is not found or retrieval fails.
   */
  public getAuth(account: string, service: string): string {
    try {
      const psCommand = `
      [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      $credential = $vault.Retrieve("${service}", "${account}")
      $credential.Password
    `

      const output = childProcess.execSync(psCommand, {encoding: 'utf8', shell: 'powershell'})
      const token = output.trim()

      if (!token) {
        throw new Error('Token not found')
      }

      return token
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to retrieve token from Windows Credential Manager: ${this.scrubError(message)}`)
    }
  }

  /**
   * Lists all accounts stored in Windows Credential Manager for a given service.
   * @param service - The service name to search for
   * @returns Array of account names found for the service
   * @throws Error if the search operation fails
   */
  public listAccounts(service: string): string[] {
    try {
      const psCommand = `
      [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      try {
        $creds = $vault.FindAllByResource("${service}")
        $creds | ForEach-Object { $_.UserName }
      } catch {
        # No credentials found for this resource
        exit 0
      }
    `

      const output = childProcess.execSync(psCommand, {encoding: 'utf8', shell: 'powershell'})

      // Expected output format:
      // user1@example.com
      // user2@example.com
      // ...

      const accounts = output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)

      return accounts
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to list accounts in Windows Credential Manager: ${this.scrubError(message)}`)
    }
  }

  /**
   * Removes the authentication token from Windows Credential Manager.
   * @param account - The account login to use (e.g. 'test@example.com')
   * @param service - The service name to use
   * @returns void
   * @throws Error if the removal operation fails.
   */
  public removeAuth(account: string, service: string): void {
    try {
      const psCommand = `
      [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      $credential = $vault.Retrieve("${service}", "${account}")
      $vault.Remove($credential)
    `
      childProcess.execSync(psCommand, {encoding: 'utf8', shell: 'powershell'})
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to remove token from Windows Credential Manager: ${this.scrubError(message)}`)
    }
  }

  /**
   * Saves an authentication entry to Windows Credential Manager.
   * If a credential with the same name already exists, it is removed before saving the new one.
   * @param auth - The authentication entry containing account and token information to store.
   * @returns void
   * @throws Error if the save operation fails.
   */
  public saveAuth(auth: KeychainAuthEntry): void {
    try {
      try {
        const removeCommand = `
        $ErrorActionPreference = 'Stop'
        [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
        $vault = New-Object Windows.Security.Credentials.PasswordVault
        $credential = $vault.Retrieve("${auth.service}", "${auth.account}")
        $vault.Remove($credential)
      `
        childProcess.execSync(removeCommand, {encoding: 'utf8', shell: 'powershell'})
      } catch {
        // noop - item does not exist
      }

      const addCommand = `
      [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      $credential = New-Object Windows.Security.Credentials.PasswordCredential("${auth.service}", "${auth.account}", "${auth.token}")
      $vault.Add($credential)
    `
      childProcess.execSync(addCommand, {encoding: 'utf8', shell: 'powershell'})
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to store token in Windows Credential Manager: ${this.scrubError(message)}`)
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
