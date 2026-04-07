import nock from 'nock'
import {resolve} from 'node:path'

import {stubCredentialManager} from './helpers/credential-manager-stub.js'

/** Mirrors @heroku-cli/test-utils initCliTest (not a devDependency here to avoid cycle with this package). */
export const mochaHooks = {
  beforeEach(done: () => void) {
    process.env.NODE_ENV = 'test'
    process.env.TS_NODE_PROJECT = resolve('test/tsconfig.json')
    Object.assign(globalThis, {columns: '120'})
    nock.disableNetConnect()
    if (process.env.ENABLE_NET_CONNECT === 'true') {
      nock.enableNetConnect()
    }

    // Command.init() awaits getAuth(); without a stub, Windows CI can hit the real Credential Manager
    // (multiple accounts → inquirer) and hang. Tests that need a custom provider override in their own beforeEach.
    stubCredentialManager()

    done()
  },
}
