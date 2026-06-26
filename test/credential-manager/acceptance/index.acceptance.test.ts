import {expect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'

import {
  getAuth, listKeychainAccounts, Netrc, removeAuth, saveAuth,
} from '../../../src/credential-manager-core/index.js'
import {
  cleanupCredentialStore,
  cleanupDefaultNetrc,
  CREDENTIAL_FIXTURES,
  setupFakeCredentialStore,
  skipUnlessAcceptance,
  snapshotDefaultNetrc,
} from '../helpers/acceptance-utils.js'

use(chaiAsPromised)

const CREDENTIAL = CREDENTIAL_FIXTURES['account-default']
const CREDENTIAL_MULTIPLE_HOSTS = CREDENTIAL_FIXTURES['account-multiple-hosts']
const CREDENTIAL_ALTERNATE_SERVICE = CREDENTIAL_FIXTURES['account-alternate-service']

describe('credential-manager acceptance', function () {
  let restoreNetrc: (() => void) | undefined
  let originalNetrcWrite: string | undefined

  before(function () {
    skipUnlessAcceptance(this)

    originalNetrcWrite = process.env.HEROKU_NETRC_WRITE

    const netrcSnapshot = snapshotDefaultNetrc()
    restoreNetrc = netrcSnapshot.restore
  })

  after(function () {
    if (originalNetrcWrite === undefined) {
      delete process.env.HEROKU_NETRC_WRITE
    } else {
      process.env.HEROKU_NETRC_WRITE = originalNetrcWrite
    }

    if (restoreNetrc) {
      restoreNetrc()
    }
  })

  describe('.netrc only', function () {
    before(function () {
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
    })

    afterEach(async function () {
      await cleanupDefaultNetrc()
    })

    after(function () {
      delete process.env.HEROKU_NETRC_WRITE
    })

    it('saves/retrieves a single host', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)

      const auth = await getAuth(CREDENTIAL.account, CREDENTIAL.hosts[0], CREDENTIAL.service)
      expect(auth).to.deep.equal({account: CREDENTIAL.account, token: CREDENTIAL.token})
    })

    it('saves/retrieves multiple hosts', async function () {
      await saveAuth(CREDENTIAL_MULTIPLE_HOSTS.account, CREDENTIAL_MULTIPLE_HOSTS.token, CREDENTIAL_MULTIPLE_HOSTS.hosts, CREDENTIAL_MULTIPLE_HOSTS.service)

      const auth1 = await getAuth(CREDENTIAL_MULTIPLE_HOSTS.account, CREDENTIAL_MULTIPLE_HOSTS.hosts[0], CREDENTIAL_MULTIPLE_HOSTS.service)
      const auth2 = await getAuth(CREDENTIAL_MULTIPLE_HOSTS.account, CREDENTIAL_MULTIPLE_HOSTS.hosts[1], CREDENTIAL_MULTIPLE_HOSTS.service)

      const expected = {account: CREDENTIAL_MULTIPLE_HOSTS.account, token: CREDENTIAL_MULTIPLE_HOSTS.token}
      expect(auth1).to.deep.equal(expected)
      expect(auth2).to.deep.equal(expected)
    })

    it('removes a single host', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)
      await removeAuth(CREDENTIAL.account, CREDENTIAL.hosts, CREDENTIAL.service)

      await expect(getAuth(CREDENTIAL.account, CREDENTIAL.hosts[0], CREDENTIAL.service))
        .to.be.rejectedWith(/No auth found|No credentials found/)
    })

    it('removes multiple hosts', async function () {
      await saveAuth(CREDENTIAL_MULTIPLE_HOSTS.account, CREDENTIAL_MULTIPLE_HOSTS.token, CREDENTIAL_MULTIPLE_HOSTS.hosts, CREDENTIAL_MULTIPLE_HOSTS.service)
      await removeAuth(CREDENTIAL_MULTIPLE_HOSTS.account, CREDENTIAL_MULTIPLE_HOSTS.hosts, CREDENTIAL_MULTIPLE_HOSTS.service)

      await expect(getAuth(CREDENTIAL_MULTIPLE_HOSTS.account, CREDENTIAL_MULTIPLE_HOSTS.hosts[0], CREDENTIAL_MULTIPLE_HOSTS.service))
        .to.be.rejectedWith(/No auth found|No credentials found/)
      await expect(getAuth(CREDENTIAL_MULTIPLE_HOSTS.account, CREDENTIAL_MULTIPLE_HOSTS.hosts[1], CREDENTIAL_MULTIPLE_HOSTS.service))
        .to.be.rejectedWith(/No auth found|No credentials found/)
    })

    it('updates entry when host already has credentials', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)
      await saveAuth(CREDENTIAL.account, 'new-token', CREDENTIAL.hosts, CREDENTIAL.service)

      const auth = await getAuth(CREDENTIAL.account, CREDENTIAL.hosts[0], CREDENTIAL.service)
      expect(auth).to.deep.equal({account: CREDENTIAL.account, token: 'new-token'})
    })

    it('skips credential store', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)

      const accounts = await listKeychainAccounts(CREDENTIAL.service)
      expect(accounts).to.deep.equal([])
    })

    it('errors when password is empty', async function () {
      await saveAuth(CREDENTIAL.account, '', CREDENTIAL.hosts, CREDENTIAL.service)

      await expect(getAuth(CREDENTIAL.account, CREDENTIAL.hosts[0], CREDENTIAL.service))
        .to.be.rejectedWith(/No auth found|No credentials found/)
    })
  })

  describe('native credential store', function () {
    before(function () {
      delete process.env.HEROKU_NETRC_WRITE
    })

    afterEach(async function () {
      await cleanupCredentialStore()
    })

    it('saves and retrieves an entry', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)

      const auth = await getAuth(CREDENTIAL.account, CREDENTIAL.hosts[0], CREDENTIAL.service)
      expect(auth).to.deep.equal({account: CREDENTIAL.account, token: CREDENTIAL.token})
    })

    it('removes an entry', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)
      await removeAuth(CREDENTIAL.account, CREDENTIAL.hosts, CREDENTIAL.service)

      await expect(getAuth(CREDENTIAL.account, CREDENTIAL.hosts[0], CREDENTIAL.service)).to.be.rejectedWith(/No auth found|No credentials found/)
    })

    it('updates entry when account already has credentials', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)
      await saveAuth(CREDENTIAL.account, 'new-token', CREDENTIAL.hosts, CREDENTIAL.service)

      const auth = await getAuth(CREDENTIAL.account, CREDENTIAL.hosts[0], CREDENTIAL.service)
      expect(auth).to.deep.equal({account: CREDENTIAL.account, token: 'new-token'})
    })

    it('lists accounts for a single service', async function () {
      const accountA = CREDENTIAL.account
      const accountB = `second-${accountA}`

      await saveAuth(accountA, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)
      await saveAuth(accountB, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)
      await saveAuth(CREDENTIAL_ALTERNATE_SERVICE.account, CREDENTIAL_ALTERNATE_SERVICE.token, CREDENTIAL_ALTERNATE_SERVICE.hosts, CREDENTIAL_ALTERNATE_SERVICE.service)

      const accounts = await listKeychainAccounts(CREDENTIAL.service)
      expect(accounts).to.have.lengthOf(2)
      expect(accounts).to.include(accountA)
      expect(accounts).to.include(accountB)
      expect(accounts).to.not.include(CREDENTIAL_ALTERNATE_SERVICE.account)
    })

    it('skips netrc', async function () {
      let netrcHasCredentials = false
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)

      const netrc = new Netrc()
      await netrc.load()
      for (const host of CREDENTIAL.hosts) {
        if (netrc.machines[host]) {
          netrcHasCredentials = true
        }
      }

      expect(netrcHasCredentials).to.be.false
    })
  })

  describe('native credential store + netrc fallback', function () {
    before(function () {
      delete process.env.HEROKU_NETRC_WRITE
    })

    afterEach(async function () {
      await cleanupCredentialStore()
      await cleanupDefaultNetrc()
    })

    it('removes from both stores when switching from netrc mode to keychain mode', async function () {
      // Login in netrc mode
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)
      delete process.env.HEROKU_NETRC_WRITE

      // Login in keychain mode (writes to keychain, old netrc credential remains)
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)

      // Logout should clean both stores
      await removeAuth(CREDENTIAL.account, CREDENTIAL.hosts, CREDENTIAL.service)

      // Verify both stores are cleaned
      await expect(getAuth(CREDENTIAL.account, CREDENTIAL.hosts[0], CREDENTIAL.service))
        .to.be.rejectedWith(/No auth found|No credentials found/)
    })

    it('saves to netrc when credential store fails', async function () {
      // Set up fake credential store command for the current platform
      const fakeSetup = setupFakeCredentialStore()

      if (!fakeSetup) {
        // Skip if credential store not available on this platform
        this.skip()
      }

      try {
        await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)

        const netrcAuth = await getAuth('missing-account@example.com', CREDENTIAL.hosts[0], CREDENTIAL.service)
        expect(netrcAuth).to.deep.equal({account: CREDENTIAL.account, token: CREDENTIAL.token})
      } finally {
        fakeSetup?.cleanup()
      }
    })

    it('errors when credentials are missing from credential store and netrc', async function () {
      await expect(getAuth(CREDENTIAL.account, CREDENTIAL.hosts[0], CREDENTIAL.service))
        .to.be.rejectedWith(/No auth found|No credentials found/)
    })
  })
})
