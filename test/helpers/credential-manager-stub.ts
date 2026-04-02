import {setCredentialManagerProvider} from '../../src/credential-manager.js'
import * as real from '../../src/credential-manager-core/index.js'

const DEFAULT_TOKEN = 'mypass'

export function stubCredentialManager(token = DEFAULT_TOKEN) {
  setCredentialManagerProvider({
    async getAuth() {
      return {
        account: 'test@example.com',
        service: 'heroku-cli',
        token,
      }
    },
    async removeAuth() {},
    async saveAuth() {},
  })
}

/** Simulates credential-manager when no token is stored (getAuth throws; APIClient.getAuth returns undefined). */
export function stubCredentialManagerWithNoCredentials() {
  setCredentialManagerProvider({
    async getAuth() {
      throw new Error('No credentials found. Please log in.')
    },
    async removeAuth() {},
    async saveAuth() {},
  })
}

export function restoreCredentialManagerStub() {
  setCredentialManagerProvider({
    getAuth: real.getAuth,
    removeAuth: real.removeAuth,
    saveAuth: real.saveAuth,
  })
}
