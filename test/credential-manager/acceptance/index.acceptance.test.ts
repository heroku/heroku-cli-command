import {expect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'
import {stderr} from 'stdout-stderr'

import {getAuth, removeAuth, saveAuth} from '../../../src/credential-manager-core/index.js'
import {unwrap} from '../../helpers/unwrap.js'
import {
  cleanupCredentialStore,
  cleanupDefaultNetrc,
  CREDENTIAL_FIXTURES,
  listCredentialStoreAccounts,
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

      const {accounts} = listCredentialStoreAccounts(CREDENTIAL.service)
      expect(accounts).to.deep.equal([])
    })
  })

  describe('native credential store', function () {
    before(function () {
      delete process.env.HEROKU_NETRC_WRITE
    })

    afterEach(function () {
      cleanupCredentialStore()
    })

    // We save with `hosts = []` to test the keychain-only path
    it('saves and retrieves an entry', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, [], CREDENTIAL.service)

      const auth = await getAuth(CREDENTIAL.account, 'missing.host.example.com', CREDENTIAL.service)
      expect(auth).to.deep.equal({account: CREDENTIAL.account, token: CREDENTIAL.token})
    })

    it('removes an entry', async function () {
      // suppressing the keychain warning message since it is not relevant to this test
      process.env.HEROKU_KEYCHAIN_WARNINGS = 'off'
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, [], CREDENTIAL.service)
      await removeAuth(CREDENTIAL.account, [], CREDENTIAL.service)

      await expect(getAuth(CREDENTIAL.account, 'missing.host.example.com', CREDENTIAL.service)).to.be.rejectedWith(/No auth found|No credentials found/)

      delete process.env.HEROKU_KEYCHAIN_WARNINGS
    })

    it('updates entry when account already has credentials', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, [], CREDENTIAL.service)
      await saveAuth(CREDENTIAL.account, 'new-token', [], CREDENTIAL.service)

      const auth = await getAuth(CREDENTIAL.account, 'missing.host.example.com', CREDENTIAL.service)
      expect(auth).to.deep.equal({account: CREDENTIAL.account, token: 'new-token'})
    })

    it('lists accounts for a single service', async function () {
      const accountA = CREDENTIAL.account
      const accountB = `second-${accountA}`

      await saveAuth(accountA, CREDENTIAL.token, [], CREDENTIAL.service)
      await saveAuth(accountB, CREDENTIAL.token, [], CREDENTIAL.service)
      await saveAuth(CREDENTIAL_ALTERNATE_SERVICE.account, CREDENTIAL_ALTERNATE_SERVICE.token, [], CREDENTIAL_ALTERNATE_SERVICE.service)

      const {accounts} = listCredentialStoreAccounts(CREDENTIAL.service)
      expect(accounts).to.have.lengthOf(2)
      expect(accounts).to.include(accountA)
      expect(accounts).to.include(accountB)
      expect(accounts).to.not.include(CREDENTIAL_ALTERNATE_SERVICE.account)
    })
  })

  describe('native credential store + netrc fallback', function () {
    before(function () {
      delete process.env.HEROKU_NETRC_WRITE
    })

    afterEach(async function () {
      cleanupCredentialStore()
      await cleanupDefaultNetrc()
    })

    it('saves/retrieves via credential store and netrc', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)

      const keychainAuth = await getAuth(CREDENTIAL.account, 'missing.host.example.com', CREDENTIAL.service)
      const netrcAuth = await getAuth('missing-account@example.com', CREDENTIAL.hosts[0], CREDENTIAL.service)

      const expected = {account: CREDENTIAL.account, token: CREDENTIAL.token}
      expect(keychainAuth).to.deep.equal(expected)
      expect(netrcAuth).to.deep.equal(expected)
    })

    it('removes via credential store and netrc', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)
      await removeAuth(CREDENTIAL.account, CREDENTIAL.hosts, CREDENTIAL.service)

      await expect(getAuth(CREDENTIAL.account, CREDENTIAL.hosts[0], CREDENTIAL.service))
        .to.be.rejectedWith(/No auth found|No credentials found/)
    })

    it('removes native store when logout runs with HEROKU_NETRC_WRITE after dual-path login', async function () {
      delete process.env.HEROKU_NETRC_WRITE
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)

      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      await removeAuth(CREDENTIAL.account, CREDENTIAL.hosts, CREDENTIAL.service)
      delete process.env.HEROKU_NETRC_WRITE

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
        stderr.start()
        await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)
        stderr.stop()

        expect(unwrap(stderr.output)).to.contain('We can’t save the Heroku token to your computer\'s keychain.')
        expect(unwrap(stderr.output)).to.contain('We\'ll save the token to the .netrc file instead.')
        expect(unwrap(stderr.output)).to.contain('To turn off this warning, set HEROKU_KEYCHAIN_WARNINGS to "off".')

        const netrcAuth = await getAuth('missing-account@example.com', CREDENTIAL.hosts[0], CREDENTIAL.service)
        expect(netrcAuth).to.deep.equal({account: CREDENTIAL.account, token: CREDENTIAL.token})
      } finally {
        fakeSetup?.cleanup()
      }
    })

    it('retrieves via netrc when credential store fails', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)

      const netrcAuth = await getAuth('missing-account@example.com', CREDENTIAL.hosts[0], CREDENTIAL.service)
      expect(netrcAuth).to.deep.equal({account: CREDENTIAL.account, token: CREDENTIAL.token})
    })

    it('removes via netrc when credential store fails', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)
      await removeAuth('missing-account@example.com', CREDENTIAL.hosts, CREDENTIAL.service)

      await expect(getAuth('missing-account@example.com', CREDENTIAL.hosts[0], CREDENTIAL.service))
        .to.be.rejectedWith(/No auth found|No credentials found/)
    })

    it('retrieves via netrc when account is undefined and no accounts are found', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)
      await removeAuth(CREDENTIAL.account, [], CREDENTIAL.service)

      const netrcAuth = await getAuth(undefined, CREDENTIAL.hosts[0], CREDENTIAL.service)
      expect(netrcAuth).to.deep.equal({account: CREDENTIAL.account, token: CREDENTIAL.token})
    })

    it('removes via netrc when account is undefined', async function () {
      await saveAuth(CREDENTIAL.account, CREDENTIAL.token, CREDENTIAL.hosts, CREDENTIAL.service)
      await removeAuth(undefined, CREDENTIAL.hosts, CREDENTIAL.service)

      await expect(getAuth('missing-account@example.com', CREDENTIAL.hosts[0], CREDENTIAL.service))
        .to.be.rejectedWith(/No auth found|No credentials found/)
    })

    it('errors when credentials are missing from credential store and netrc', async function () {
      await expect(getAuth(CREDENTIAL.account, CREDENTIAL.hosts[0], CREDENTIAL.service))
        .to.be.rejectedWith(/No auth found|No credentials found/)
    })
  })
})
