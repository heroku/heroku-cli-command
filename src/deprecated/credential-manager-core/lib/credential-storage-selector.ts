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
 * Determines whether to use OS-native credential storage or .netrc file.
 *
 * By default, uses keychain exclusively (when available).
 * `HEROKU_NETRC_WRITE=true` selects netrc-only mode, skipping keychain entirely.
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
 *   // Use netrc handler (explicit override mode)
 * }
 * ```
 */
export function getStorageConfig(): StorageConfig {
  const netrcWriteLegacy = process.env.HEROKU_NETRC_WRITE?.toLowerCase() === 'true'

  if (netrcWriteLegacy) {
    return {
      credentialStore: null,
      useNetrc: true,
    }
  }

  const nativeCredentialStore = getNativeCredentialStore()

  return {
    credentialStore: nativeCredentialStore,
    useNetrc: !nativeCredentialStore,
  }
}
