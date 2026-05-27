import {expect} from 'chai'
import {Context} from 'mocha'
import fs from 'node:fs'
import sinon from 'sinon'

import {MacOSHandler, Netrc} from '../../../src/credential-manager-core/index.js'
import {
  ALTERNATE_HOST_NAME,
  ALTERNATE_SERVICE_NAME,
  cleanupCredentialStore,
  cleanupDefaultNetrc,
  getAllAcceptanceHosts,
  getAllAcceptanceServices,
  HOST_NAME,
  isPowerShellAvailable,
  isSecretToolAvailable,
  isSecurityAvailable,
  listCredentialStoreAccounts,
  SERVICE_NAME,
  setupFakeCredentialStore,
  skipUnlessAcceptance,
  snapshotDefaultNetrc,
} from './acceptance-utils.js'

describe('acceptance utils', function () {
  afterEach(function () {
    sinon.restore()
  })

  describe('skipUnlessAcceptance', function () {
    beforeEach(function () {
      sinon.stub(process, 'env').value({...process.env})
    })

    it('skips when env is missing', function () {
      delete process.env.ACCEPTANCE_TESTS
      const context = {skip: sinon.stub()} as unknown as Context

      skipUnlessAcceptance(context)

      expect((context.skip as unknown as sinon.SinonStub).calledOnce).to.equal(true)
    })

    it('skips when env is not true', function () {
      process.env.ACCEPTANCE_TESTS = 'false'
      const context = {skip: sinon.stub()} as unknown as Context

      skipUnlessAcceptance(context)

      expect((context.skip as unknown as sinon.SinonStub).calledOnce).to.equal(true)
    })

    it('does not skip when env is true', function () {
      process.env.ACCEPTANCE_TESTS = 'true'
      const context = {skip: sinon.stub()} as unknown as Context

      skipUnlessAcceptance(context)

      expect((context.skip as unknown as sinon.SinonStub).notCalled).to.equal(true)
    })
  })

  describe('getAllAcceptanceHosts', function () {
    it('returns all hosts referenced by the fixture', function () {
      const hosts = getAllAcceptanceHosts()

      expect(hosts).to.include(HOST_NAME)
      expect(hosts).to.include(ALTERNATE_HOST_NAME)
      expect(new Set(hosts).size).to.equal(hosts.length)
    })
  })

  describe('getAllAcceptanceServices', function () {
    it('returns all services referenced by the fixture', function () {
      const services = getAllAcceptanceServices()

      expect(services).to.include(SERVICE_NAME)
      expect(services).to.include(ALTERNATE_SERVICE_NAME)
      expect(new Set(services).size).to.equal(services.length)
    })
  })

  describe('listCredentialStoreAccounts', function () {
    beforeEach(function () {
      sinon.stub(process, 'platform').value('darwin')
      sinon.stub(process, 'env').value({...process.env})
    })

    it('returns an empty list when credential store is disabled', function () {
      process.env.HEROKU_NETRC_WRITE = 'true'

      const result = listCredentialStoreAccounts(SERVICE_NAME)
      expect(result).to.deep.equal({accounts: []})
    })

    it('returns handler and accounts when credential store is enabled', function () {
      delete process.env.HEROKU_NETRC_WRITE
      sinon.stub(MacOSHandler.prototype, 'listAccounts').returns(['test@example.com'])

      const result = listCredentialStoreAccounts(SERVICE_NAME)

      expect(result.handler).to.be.instanceOf(MacOSHandler)
      expect(result.accounts).to.deep.equal(['test@example.com'])
    })
  })

  describe('cleanupCredentialStore', function () {
    let listAccountsStub: sinon.SinonStub
    let removeAuthStub: sinon.SinonStub

    beforeEach(function () {
      sinon.stub(process, 'platform').value('darwin')
      sinon.stub(process, 'env').value({...process.env})

      listAccountsStub = sinon.stub(MacOSHandler.prototype, 'listAccounts')
      removeAuthStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
    })

    it('is a no-op when credential store is disabled', function () {
      process.env.HEROKU_NETRC_WRITE = 'true'

      expect(() => cleanupCredentialStore()).to.not.throw()
      expect(listAccountsStub.notCalled).to.equal(true)
      expect(removeAuthStub.notCalled).to.equal(true)
    })

    it('removes all accounts for all fixture services', function () {
      delete process.env.HEROKU_NETRC_WRITE
      listAccountsStub.withArgs(SERVICE_NAME).returns(['test@example.com', 'second@example.com'])
      listAccountsStub.withArgs(ALTERNATE_SERVICE_NAME).returns(['third@example.com'])

      cleanupCredentialStore()

      expect(removeAuthStub.callCount).to.equal(3)
      expect(removeAuthStub.calledWith('test@example.com', SERVICE_NAME)).to.equal(true)
      expect(removeAuthStub.calledWith('second@example.com', SERVICE_NAME)).to.equal(true)
      expect(removeAuthStub.calledWith('third@example.com', ALTERNATE_SERVICE_NAME)).to.equal(true)
    })

    it('does nothing when there are no accounts to remove', function () {
      delete process.env.HEROKU_NETRC_WRITE
      listAccountsStub.returns([])

      cleanupCredentialStore()
      expect(removeAuthStub.notCalled).to.equal(true)
    })
  })

  describe('cleanupDefaultNetrc', function () {
    let saveStub: sinon.SinonStub
    let loadStub: sinon.SinonStub

    beforeEach(function () {
      saveStub = sinon.stub(Netrc.prototype, 'save')
      loadStub = sinon.stub(Netrc.prototype, 'load')
    })

    it('removes all known fixture hosts', async function () {
      loadStub.callsFake(async function (this: Netrc) {
        this.machines = {
          [ALTERNATE_HOST_NAME]: {login: 'test-alt@example.com', password: 'test-token-alt'},
          [HOST_NAME]: {login: 'test@example.com', password: 'test-token'},
          'unrelated.host.test': {login: 'unrelated@example.com', password: 'unrelated-token'},
        }
      })

      let machinesAfterCleanup: Record<string, unknown> = {}
      saveStub.callsFake(async function (this: Netrc) {
        machinesAfterCleanup = {...(this.machines as Record<string, unknown>)}
      })

      await cleanupDefaultNetrc()

      expect(saveStub.calledOnce).to.equal(true)
      expect(machinesAfterCleanup[HOST_NAME]).to.equal(undefined)
      expect(machinesAfterCleanup[ALTERNATE_HOST_NAME]).to.equal(undefined)
      expect(machinesAfterCleanup['unrelated.host.test']).to.deep.equal({login: 'unrelated@example.com', password: 'unrelated-token'})
    })

    it('does nothing when there are no hosts to remove', async function () {
      loadStub.callsFake(async function (this: Netrc) {
        this.machines = {
          'unrelated.host.test': {login: 'unrelated@example.com', password: 'unrelated-token'},
        }
      })

      await cleanupDefaultNetrc()
      expect(saveStub.notCalled).to.equal(true)
    })
  })

  describe('snapshotDefaultNetrc', function () {
    let existsSyncStub: sinon.SinonStub
    let readFileSyncStub: sinon.SinonStub
    let writeFileSyncStub: sinon.SinonStub
    let rmSyncStub: sinon.SinonStub

    beforeEach(function () {
      existsSyncStub = sinon.stub(fs, 'existsSync')
      readFileSyncStub = sinon.stub(fs, 'readFileSync')
      writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
      rmSyncStub = sinon.stub(fs, 'rmSync')
    })

    it('restores original contents when default netrc already exists', function () {
      const netrcPath = '/tmp/test-existing.netrc'
      const originalContents = Buffer.from('machine api.heroku.com login test password secret\n')

      sinon.stub(Netrc.prototype as unknown as {defaultFile: string}, 'defaultFile').get(() => netrcPath)
      existsSyncStub.returns(true)
      readFileSyncStub.returns(originalContents)

      const snapshot = snapshotDefaultNetrc()
      expect(snapshot.netrcPath).to.equal(netrcPath)

      snapshot.restore()
      snapshot.restore()

      expect(writeFileSyncStub.calledOnceWithExactly(netrcPath, originalContents)).to.equal(true)
      expect(rmSyncStub.notCalled).to.equal(true)
    })

    it('removes netrc when no default netrc existed before test', function () {
      const netrcPath = '/tmp/test-missing.netrc'

      sinon.stub(Netrc.prototype as unknown as {defaultFile: string}, 'defaultFile').get(() => netrcPath)
      existsSyncStub.returns(false)

      const snapshot = snapshotDefaultNetrc()
      expect(snapshot.netrcPath).to.equal(netrcPath)

      snapshot.restore()
      snapshot.restore()

      expect(readFileSyncStub.notCalled).to.equal(true)
      expect(writeFileSyncStub.notCalled).to.equal(true)
      expect(rmSyncStub.calledOnceWithExactly(netrcPath, {force: true})).to.equal(true)
    })
  })

  // Integration-style tests that don't require stubbing ES modules
  describe('isSecretToolAvailable', function () {
    it('returns a boolean', function () {
      const result = isSecretToolAvailable()
      expect(typeof result).to.equal('boolean')
    })
  })

  describe('isSecurityAvailable', function () {
    it('returns a boolean', function () {
      const result = isSecurityAvailable()
      expect(typeof result).to.equal('boolean')
    })
  })

  describe('isPowerShellAvailable', function () {
    it('returns a boolean', function () {
      const result = isPowerShellAvailable()
      expect(typeof result).to.equal('boolean')
    })
  })

  describe('setupFakeCredentialStore', function () {
    it('returns undefined or a setup object with cleanup', function () {
      const setup = setupFakeCredentialStore()

      if (setup) {
        expect(setup).to.have.property('cleanup')
        expect(setup).to.have.property('originalPath')
        expect(setup).to.have.property('tmpDir')
        expect(typeof setup.cleanup).to.equal('function')
        expect(typeof setup.originalPath).to.equal('string')
        expect(typeof setup.tmpDir).to.equal('string')

        // Cleanup after test
        setup.cleanup()
      } else {
        expect(setup).to.equal(undefined)
      }
    })
  })
})
