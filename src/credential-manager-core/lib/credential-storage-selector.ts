import childProcess from 'node:child_process'

export const CredentialStore = {
  LinuxSecretService: 'linux-secret-service',
  MacOSKeychain: 'macos-keychain',
  WindowsCredentialManager: 'windows-credential-manager',
} as const

export type CredentialStore = typeof CredentialStore[keyof typeof CredentialStore]

export type StorageConfig = {
  credentialStore: CredentialStore | null
  useNetrc: boolean
}

/**
 * Determines whether the secret-tool command is accessible.
 *
 * @returns True if secret-tool is installed and accessible, false otherwise
 */
function hasSecretTool(): boolean {
  try {
    childProcess.execSync('which secret-tool', {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Native credential backend for this platform (Keychain, Secret Service, Windows vault).
 * Ignores HEROKU_NETRC_WRITE so logout can clear credentials written before that mode was used.
 */
export function getNativeCredentialStore(): CredentialStore | null {
  const {platform} = process

  switch (platform) {
    case 'darwin': {
      return CredentialStore.MacOSKeychain
    }

    case 'linux': {
      return hasSecretTool() ? CredentialStore.LinuxSecretService : null
    }

    case 'win32': {
      return CredentialStore.WindowsCredentialManager
    }

    default: {
      return null
    }
  }
}

/**
 * Determines whether to use OS-native credential storage, .netrc file, or both.
 *
 * `HEROKU_NETRC_WRITE=true` alone selects legacy netrc-only reads/writes (no native store on the primary path).
 * `HEROKU_KEYCHAIN_WRITE=true` skips .netrc on the primary path so the native store can be tested in isolation.
 * When both are `true`, credentials use the native store and .netrc (dual path).
 *
 * @returns Object containing storage configuration
 *
 * @example
 * ```typescript
 * const config = getStorageConfig()
 * if (config.credentialStore === CredentialStore.MacOSKeychain) {
 *   // Use macOS handler
 * }
 * if (config.useNetrc) {
 *   // Also use netrc handler
 * }
 * ```
 */
export function getStorageConfig(): StorageConfig {
  const netrcWriteLegacy = process.env.HEROKU_NETRC_WRITE?.toLowerCase() === 'true'
  const keychainWriteEnabled = process.env.HEROKU_KEYCHAIN_WRITE?.toLowerCase() === 'true'

  if (netrcWriteLegacy && !keychainWriteEnabled) {
    return {
      credentialStore: null,
      useNetrc: true,
    }
  }

  return {
    credentialStore: getNativeCredentialStore(),
    useNetrc: !keychainWriteEnabled || netrcWriteLegacy,
  }
}
