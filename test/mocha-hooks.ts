import {stubCredentialManager} from './helpers/credential-manager-stub.js'

/** Mirrors @heroku-cli/test-utils initCliTest (not a devDependency here to avoid cycle with this package). */
export const mochaHooks = {
  beforeEach(done: () => void) {
    // Command.init() awaits getAuth(); without a stub, Windows CI can hit the real Credential Manager
    // (multiple accounts → inquirer) and hang. Tests that need a custom provider override in their own beforeEach.
    stubCredentialManager()

    done()
  },
}
