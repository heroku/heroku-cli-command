import {expect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'

import * as credentialManager from '../../../src/credential-manager-core/index.js'
import {
  CREDENTIAL_FIXTURES, setupTempNetrcDir, skipUnlessAcceptanceEnv,
} from './helpers.js'

use(chaiAsPromised)

describe('credential-manager', function () {
  before(function () {
    skipUnlessAcceptanceEnv(this)
  })

  describe('netrc-only', function () {
    let restoreNetrc: (() => void) | undefined
    let originalNetrcWrite: string | undefined

    before(function () {
      originalNetrcWrite = process.env.HEROKU_NETRC_WRITE
      process.env.HEROKU_NETRC_WRITE = 'TRUE'

      const temp = setupTempNetrcDir()
      restoreNetrc = temp.restore
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

    afterEach(async function () {
      for (const credential of Object.values(CREDENTIAL_FIXTURES)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await credentialManager.removeAuth(credential.account, credential.hosts, credential.service)
        } catch {
          // ignore cleanup errors
        }
      }
    })

    it('saves and retrieves a credential (one host)', async function () {
      const credential = CREDENTIAL_FIXTURES['account-default']
      await credentialManager.saveAuth(
        credential.account,
        credential.token,
        credential.hosts,
        credential.service,
      )
      const token = await credentialManager.getAuth(
        credential.account,
        credential.hosts[0],
        credential.service,
      )
      expect(token).to.equal(credential.token)
    })

    it('saves and retrieves a credential (multiple hosts)', async function () {
      const credential = CREDENTIAL_FIXTURES['account-multiple-hosts']
      await credentialManager.saveAuth(
        credential.account,
        credential.token,
        credential.hosts,
        credential.service,
      )
      const token = await credentialManager.getAuth(
        credential.account,
        credential.hosts[0],
        credential.service,
      )
      expect(token).to.equal(credential.token)
      const token2 = await credentialManager.getAuth(
        credential.account,
        credential.hosts[1],
        credential.service,
      )
      expect(token2).to.equal(credential.token)
    })

    it('removes a credential (one host)', async function () {
      const credential = CREDENTIAL_FIXTURES['account-default']
      await credentialManager.saveAuth(
        credential.account,
        credential.token,
        credential.hosts,
        credential.service,
      )
      await credentialManager.removeAuth(credential.account, credential.hosts, credential.service)
      await expect(
        credentialManager.getAuth(credential.account, credential.hosts[0], credential.service),
      ).to.be.rejectedWith(Error, `No auth found for ${credential.hosts[0]}`)
    })

    it('removes a credential (multiple hosts)', async function () {
      const credential = CREDENTIAL_FIXTURES['account-multiple-hosts']
      await credentialManager.saveAuth(
        credential.account,
        credential.token,
        credential.hosts,
        credential.service,
      )
      await credentialManager.removeAuth(credential.account, credential.hosts, credential.service)
      await expect(
        credentialManager.getAuth(credential.account, credential.hosts[0], credential.service),
      ).to.be.rejectedWith(Error, `No auth found for ${credential.hosts[0]}`)
      await expect(
        credentialManager.getAuth(credential.account, credential.hosts[1], credential.service),
      ).to.be.rejectedWith(Error, `No auth found for ${credential.hosts[1]}`)
    })
  })

  describe('native credential store with netrc', function () {
    let restoreNetrc: (() => void) | undefined

    before(function () {
      const temp = setupTempNetrcDir()
      restoreNetrc = temp.restore
    })

    after(function () {
      if (restoreNetrc) {
        restoreNetrc()
      }
    })
    
    afterEach(async function () {
      for (const credential of Object.values(CREDENTIAL_FIXTURES)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await credentialManager.removeAuth(credential.account, credential.hosts, credential.service)
        } catch {
        // ignore cleanup errors
        }
      }
    })

    it('saves and retrieves a credential', async function () {
      console.log('=== made it to "saves and retrieves a credential" ===')
      const credential = CREDENTIAL_FIXTURES['account-default']
      await credentialManager.saveAuth(
        credential.account,
        credential.token,
        credential.hosts,
        credential.service,
      )

      console.log('=== made it to "saveAuth" ===')

      const token = await credentialManager.getAuth(
        credential.account,
        credential.hosts[0],
        credential.service,
      )

      console.log('=== made it to "getAuth" ===')

      expect(token).to.equal(credential.token)
    })

    it('removes a credential', async function () {
      console.log('=== made it to "removes a credential" ===')
      const credential = CREDENTIAL_FIXTURES['account-default']
      await credentialManager.saveAuth(
        credential.account,
        credential.token,
        credential.hosts,
        credential.service,
      )

      console.log('=== made it to "saveAuth" ===')

      await credentialManager.removeAuth(credential.account, credential.hosts, credential.service)

      console.log('=== made it to "removeAuth" ===')

      await expect(
        credentialManager.getAuth(credential.account, credential.hosts[0], credential.service),
      ).to.be.rejectedWith(Error, `No auth found for ${credential.hosts[0]}`)
    })
  })
})
