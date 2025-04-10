/**
 * Functions for securely storing bearer tokens using OS-level utilities.
 * These functions are limited to credentials and do not provide general
 * encryption for arbitrary data.
 *
 * If you need to store and retrieve sensitive information other
 * than credentials, you should consider using the utilities provided by
 * `file-encryption.ts` instead.
 */

import {execSync} from 'child_process'
import * as os from 'os'
import * as crypto from 'crypto'

export const SERVICE_NAME = 'heroku'

/**
 * Derives a unique token name based on the service name and machine/user info
 *
 * @param serviceName - The name of the service for which the token is being stored
 * @returns A derived token name based on the service name and machine/user info
 */
function deriveTokenName(serviceName = SERVICE_NAME): string {
  // Use only deterministic components
  // but ensure uniqueness across services and machines
  // This is an added layer of protection to prevent token collisions
  // and guarantees the token name is not easily guessable
  const components = [
    serviceName,           // Service name
    os.hostname(),         // Machine hostname
    os.userInfo().username, // OS username
  ]

  // Create a hash of the combined components
  // to ensure the token length is known and consistent
  const hash = crypto.createHash('sha256')
    .update(components.join('::'))
    .digest('hex')
    .slice(0, 32)

  return `${serviceName}_${hash}`
}

/**
 * Stores a bearer token securely on macOS using the Keychain
 * @param tokenName - Unique identifier/name for the token
 * @param tokenValue - The bearer token value to store
 * @throws Error if the token cannot be stored
 * @returns void
 */
function storeTokenMacOS(tokenName: string, tokenValue: string): void {
  try {
    try {
      execSync(`security delete-generic-password -a "${tokenName}" -s "bearer_token"`)
    } catch {
      // noop - item does not exist
    }

    execSync(`security add-generic-password -a "${tokenName}" -s "bearer_token" -w "${tokenValue}"`)
  } catch (error) {
    const {message} = error as Error
    throw new Error(`Failed to store token in macOS Keychain: ${message}`)
  }
}

/**
 * Stores a bearer token securely on Windows using Windows Credential Manager
 * @param tokenName - Unique identifier/name for the token
 * @param tokenValue - The bearer token value to store
 * @throws Error if the token cannot be stored
 * @returns void
 */
function storeTokenWindows(tokenName: string, tokenValue: string): void {
  try {
    try {
      const removeCommand = `
        [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
        $vault = New-Object Windows.Security.Credentials.PasswordVault
        $credential = $vault.Retrieve("${tokenName}", "${tokenName}")
        $vault.Remove($credential)
      `
      execSync(removeCommand, {shell: 'powershell'})
    } catch {
      // noop - item does not exist
    }

    const addCommand = `
      [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      $credential = New-Object Windows.Security.Credentials.PasswordCredential("${tokenName}", "${tokenName}", "${tokenValue}")
      $vault.Add($credential)
    `
    execSync(addCommand, {shell: 'powershell'})
  } catch (error) {
    const {message} = error as Error
    throw new Error(`Failed to store token in Windows Credential Manager: ${message}`)
  }
}

/**
 * Stores a bearer token securely on Linux using the system keyring (via secret-tool)
 * @param tokenName - Unique identifier/name for the token
 * @param tokenValue - The bearer token value to store
 * @throws Error if the token cannot be stored or if secret-tool is not installed
 * @returns void
 */
function storeTokenLinux(tokenName: string, tokenValue: string): void {
  try {
    try {
      execSync(`secret-tool clear type bearer_token name "${tokenName}"`)
    } catch {
      // noop - item does not exist
    }

    execSync(`echo "${tokenValue}" | secret-tool store --label="${tokenName}" type bearer_token name "${tokenName}"`)
  } catch (error) {
    const {message} = error as Error
    throw new Error(`Failed to store token in Linux keyring: ${message}. Make sure secret-tool is installed.`)
  }
}

/**
 * Retrieves a stored bearer token on macOS from the Keychain
 * @param tokenName - Unique identifier/name of the token to retrieve
 * @throws Error if the token cannot be retrieved
 * @returns void
 */
function retrieveTokenMacOS(tokenName: string): string {
  try {
    const output = execSync(`security find-generic-password -a "${tokenName}" -s "bearer_token" -w`)
    return output.toString().trim()
  } catch (error) {
    const {message} = error as Error
    throw new Error(`Failed to retrieve token from macOS Keychain: ${message}`)
  }
}

/**
 * Retrieves a stored bearer token on Windows from the Credential Manager
 * @param tokenName - Unique identifier/name of the token to retrieve
 * @throws Error if the token cannot be retrieved
 * @returns void
 */
function retrieveTokenWindows(tokenName: string): string {
  try {
    const psCommand = `
      [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      $credential = $vault.Retrieve("${tokenName}", "${tokenName}")
      $credential.Password
    `

    const output = execSync(psCommand, {shell: 'powershell'})
    const token = output.toString().trim()

    if (!token) {
      throw new Error('Token not found')
    }

    return token
  } catch (error) {
    const {message} = error as Error
    throw new Error(`Failed to retrieve token from Windows Credential Manager: ${message}`)
  }
}

/**
 * Retrieves a stored bearer token on Linux from the system keyring
 *
 * @param tokenName - Unique identifier/name of the token to retrieve
 * @throws Error if the token cannot be retrieved
 * @returns void
 */
function retrieveTokenLinux(tokenName: string): string {
  try {
    const output = execSync(`secret-tool lookup type bearer_token name "${tokenName}"`)
    return output.toString().trim()
  } catch (error) {
    const {message} = error as Error
    throw new Error(`Failed to retrieve token from Linux keyring: ${message}`)
  }
}

/**
 * Removes a stored bearer token from macOS Keychain
 *
 * @param tokenName - Unique identifier/name of the token to remove
 * @throws Error if the token cannot be removed or doesn't exist
 * @returns void
 */
function removeTokenMacOS(tokenName: string): void {
  try {
    execSync(`security delete-generic-password -a "${tokenName}" -s "bearer_token"`)
  } catch (error) {
    const {message} = error as Error
    throw new Error(`Failed to remove token from macOS Keychain: ${message}`)
  }
}

/**
 * Removes a stored bearer token from Windows Credential Manager
 *
 * @param tokenName - Unique identifier/name of the token to remove
 * @throws Error if the token cannot be removed or doesn't exist
 * @returns void
 */
function removeTokenWindows(tokenName: string): void {
  try {
    const psCommand = `
      [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      $credential = $vault.Retrieve("${tokenName}", "${tokenName}")
      $vault.Remove($credential)
    `
    execSync(psCommand, {shell: 'powershell'})
  } catch (error) {
    const {message} = error as Error
    throw new Error(`Failed to remove token from Windows Credential Manager: ${message}`)
  }
}

/**
 * Removes a stored bearer token from Linux system keyring
 *
 * @param tokenName - Unique identifier/name of the token to remove
 * @throws Error if the token cannot be removed or doesn't exist
 * @returns void
 */
function removeTokenLinux(tokenName: string): void {
  try {
    execSync(`secret-tool clear type bearer_token name "${tokenName}"`)
  } catch (error) {
    const {message} = error as Error
    throw new Error(`Failed to remove token from Linux keyring: ${message}`)
  }
}

/**
 * Removes a stored bearer token using OS-level utilities
 *
 * @param serviceName - The name of the service for which the token is being removed. Defaults to 'heroku'
 * @throws Error if the token cannot be removed or if the platform is not supported
 * @returns Promise that resolves when the token is removed
 *
 * @example
 * ```typescript
 * // Remove token for default service (heroku)
 * removeToken();
 *
 * // Remove token for a specific service
 * removeToken('my-service');
 * ```
 */
export function removeToken(serviceName?: string): void {
  const tokenName = deriveTokenName(serviceName)
  switch (process.platform) {
  case 'win32':
    removeTokenWindows(tokenName)
    break
  case 'darwin':
    removeTokenMacOS(tokenName)
    break
  case 'linux':
    removeTokenLinux(tokenName)
    break
  default:
    throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

/**
 * Stores a bearer token securely using OS-level utilities
 *
 * @param token the token to store
 * @param serviceName the name of the service for which the token is being stored. defaults to 'heroku'
 * @returns a promise that resolves when the token is stored
 */
export function storeToken(token: string, serviceName?: string): void {
  const tokenName = deriveTokenName(serviceName)
  switch (process.platform) {
  case 'win32':
    storeTokenWindows(tokenName, token)
    break
  case 'darwin':
    storeTokenMacOS(tokenName, token)
    break
  case 'linux':
    storeTokenLinux(tokenName, token)
    break
  default:
    throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

/**
 * Retrieves a stored bearer token securely using OS-level utilities
 *
 * @param serviceName the name of the service for which the token is being stored. defaults to 'heroku'
 * @returns a promise that resolves with the stored token
 */
export function retrieveToken(serviceName?: string): string {
  const tokenName = deriveTokenName(serviceName)
  switch (process.platform) {
  case 'win32':
    return retrieveTokenWindows(tokenName)
  case 'darwin':
    return retrieveTokenMacOS(tokenName)
  case 'linux':
    return retrieveTokenLinux(tokenName)
  default:
    throw new Error(`Unsupported platform: ${process.platform}`)
  }
}
