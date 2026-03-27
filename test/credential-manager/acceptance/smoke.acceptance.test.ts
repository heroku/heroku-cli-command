import {expect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'

import {getAuth, removeAuth, saveAuth} from '../../../src/credential-manager-core/index.js'

import {
  CREDENTIAL_FIXTURES,
  cleanupDefaultNetrc,
  cleanupCredentialStore,
  snapshotDefaultNetrc,
  skipUnlessAcceptance,
} from '../helpers/acceptance-utils.js'

use(chaiAsPromised)

describe('credential-manager acceptance smoke', function () {
  before(function () {
    skipUnlessAcceptance(this)
  })

  const CREDENTIAL = CREDENTIAL_FIXTURES['account-default']

  describe('.netrc', function () {
    let restoreNetrc: (() => void) | undefined
    let originalNetrcWrite: string | undefined

    before(function () {
      originalNetrcWrite = process.env.HEROKU_NETRC_WRITE
      process.env.HEROKU_NETRC_WRITE = 'TRUE'

      const netrcSnapshot = snapshotDefaultNetrc()
      restoreNetrc = netrcSnapshot.restore
    })

    afterEach(async function () {
      await cleanupDefaultNetrc(CREDENTIAL.hosts)
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

    it('saves and retrieves', async function () {
      await saveAuth(
        CREDENTIAL.account,
        CREDENTIAL.token,
        CREDENTIAL.hosts,
        CREDENTIAL.service,
      )

      const token = await getAuth(
        CREDENTIAL.account,
        CREDENTIAL.hostForLookup,
        CREDENTIAL.service,
      )

      expect(token).to.equal(CREDENTIAL.token)
    })

    it('removes', async function () {
      await saveAuth(
        CREDENTIAL.account,
        CREDENTIAL.token,
        CREDENTIAL.hosts,
        CREDENTIAL.service,
      )

      await removeAuth(
        CREDENTIAL.account,
        CREDENTIAL.hosts,
        CREDENTIAL.service,
      )

      await expect(
				getAuth(CREDENTIAL.account, CREDENTIAL.hostForLookup, CREDENTIAL.service),
			).to.be.rejectedWith(/No auth found|No credentials found/)
    })
  })

  describe('native credential store', function () {
    afterEach(function () {
      cleanupCredentialStore(CREDENTIAL.service)
    })

  // We pass hosts as an empty array test the keychain-only path
    it('saves and retrieves', async function () {
      await saveAuth(
        CREDENTIAL.account,
        CREDENTIAL.token,
        [],
        CREDENTIAL.service,
      )

      const token = await getAuth(
        CREDENTIAL.account,
        CREDENTIAL.hostForLookup,
        CREDENTIAL.service,
      )

      expect(token).to.equal(CREDENTIAL.token)
    })

    it('removes', async function () {
      await saveAuth(
        CREDENTIAL.account,
        CREDENTIAL.token,
        [],
        CREDENTIAL.service,
      )

      await removeAuth(
        CREDENTIAL.account,
        [],
        CREDENTIAL.service,
      )

      await expect(
				getAuth(CREDENTIAL.account, CREDENTIAL.hostForLookup, CREDENTIAL.service),
			).to.be.rejectedWith(/No auth found|No credentials found/)
    })
  })
})
