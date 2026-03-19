import * as real from '@heroku/heroku-credential-manager'

import {setCredentialManagerProvider} from '../../src/credential-manager.js'

const DEFAULT_TOKEN = 'mypass'

export function stubCredentialManager(token = DEFAULT_TOKEN) {
  setCredentialManagerProvider({
    async getAuth() {
      return token
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
