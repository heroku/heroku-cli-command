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
  if (process.env.HEROKU_NETRC_WRITE?.toLowerCase() === 'true') {
    return {
      credentialStore: null,
      useNetrc: true,
    }
  }

  return {
    credentialStore: getNativeCredentialStore(),
    useNetrc: true,
  }
}
