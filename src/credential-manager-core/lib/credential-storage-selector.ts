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
 * Storage layout for this OS when not forcing netrc-only via HEROKU_NETRC_WRITE.
 * Used internally and for logout/removal so all backends are cleared.
 */
function getPlatformStorageConfig(): StorageConfig {
  switch (process.platform) {
  case 'darwin': {
    return {
      credentialStore: CredentialStore.MacOSKeychain,
      useNetrc: true,
    }
  }

  case 'linux': {
    if (hasSecretTool()) {
      return {
        credentialStore: CredentialStore.LinuxSecretService,
        useNetrc: true,
      }
    }

    // secret-tool not accessible, fall back to netrc only
    return {
      credentialStore: null,
      useNetrc: true,
    }
  }

  case 'win32': {
    return {
      credentialStore: CredentialStore.WindowsCredentialManager,
      useNetrc: true,
    }
  }

  default: {
    // Unsupported platform, fall back to netrc only
    return {
      credentialStore: null,
      useNetrc: true,
    }
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
  const {HEROKU_NETRC_WRITE} = process.env

  // Forces the use of the .netrc file only
  if (HEROKU_NETRC_WRITE?.toLowerCase() === 'true') {
    return {
      credentialStore: null,
      useNetrc: true,
    }
  }

  return getPlatformStorageConfig()
}

/**
 * Storage config for removing credentials (logout). Ignores HEROKU_NETRC_WRITE so
 * tokens are cleared from both the OS store and .netrc when the platform normally
 * uses both — otherwise netrc-only logout can leave Keychain (etc.) populated.
 */
export function getStorageConfigForRemoval(): StorageConfig {
  return getPlatformStorageConfig()
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
