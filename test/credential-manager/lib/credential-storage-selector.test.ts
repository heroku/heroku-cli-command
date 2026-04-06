import {expect} from 'chai'
import childProcess from 'node:child_process'
import sinon from 'sinon'

import {CredentialStore, getStorageConfig, getStorageConfigForRemoval} from '../../../src/credential-manager-core/lib/credential-storage-selector.js'

describe('credential-storage-selector', function () {
  describe('getStorageConfig', function () {
    let platformStub: sinon.SinonStub

    beforeEach(function () {
      platformStub = sinon.stub(process, 'platform')
      const env = {...process.env}
      sinon.stub(process, 'env').value(env)
      delete env.HEROKU_NETRC_WRITE
    })

    afterEach(function () {
      sinon.restore()
    })

    it('should return netrc-only when HEROKU_NETRC_WRITE is true', function () {
      platformStub.value('darwin')
      process.env.HEROKU_NETRC_WRITE = 'TRUE'

      const result = getStorageConfig()

      expect(result.credentialStore).to.be.null
      expect(result.useNetrc).to.be.true
    })

    it('should return macOS Keychain + netrc for darwin platform', function () {
      platformStub.value('darwin')

      const result = getStorageConfig()

      expect(result.credentialStore).to.equal(CredentialStore.MacOSKeychain)
      expect(result.useNetrc).to.be.true
    })

    it('should return Windows Credential Manager + netrc for win32 platform', function () {
      platformStub.value('win32')

      const result = getStorageConfig()

      expect(result.credentialStore).to.equal(CredentialStore.WindowsCredentialManager)
      expect(result.useNetrc).to.be.true
    })

    it('should return Linux Secret Service + netrc when secret-tool is available', function () {
      platformStub.value('linux')

      const execSyncStub = sinon.stub(childProcess, 'execSync')
      execSyncStub.returns(Buffer.from('/usr/bin/secret-tool\n'))

      const result = getStorageConfig()

      expect(result.credentialStore).to.equal(CredentialStore.LinuxSecretService)
      expect(result.useNetrc).to.be.true
    })

    it('should return netrc-only when secret-tool is not available', function () {
      platformStub.value('linux')

      const execSyncStub = sinon.stub(childProcess, 'execSync')
      execSyncStub.throws(new Error('secret-tool not found'))

      const result = getStorageConfig()

      expect(result.credentialStore).to.be.null
      expect(result.useNetrc).to.be.true
    })

    it('should return netrc-only for unsupported platforms', function () {
      platformStub.value('freebsd')

      const result = getStorageConfig()

      expect(result.credentialStore).to.be.null
      expect(result.useNetrc).to.be.true
    })
  })

  describe('getStorageConfigForRemoval', function () {
    let platformStub: sinon.SinonStub

    beforeEach(function () {
      platformStub = sinon.stub(process, 'platform')
      const env = {...process.env}
      sinon.stub(process, 'env').value(env)
      delete env.HEROKU_NETRC_WRITE
    })

    afterEach(function () {
      sinon.restore()
    })

    it('ignores HEROKU_NETRC_WRITE and returns native store on darwin', function () {
      platformStub.value('darwin')
      process.env.HEROKU_NETRC_WRITE = 'TRUE'

      const result = getStorageConfigForRemoval()

      expect(result.credentialStore).to.equal(CredentialStore.MacOSKeychain)
      expect(result.useNetrc).to.be.true
    })

    it('matches platform defaults when HEROKU_NETRC_WRITE is unset', function () {
      platformStub.value('darwin')

      expect(getStorageConfigForRemoval()).to.deep.equal(getStorageConfig())
    })
  })
})
