import {expect} from 'chai'
import childProcess from 'node:child_process'
import sinon from 'sinon'

import {CredentialStore, getNativeCredentialStore, getStorageConfig} from '../../../src/credential-manager-core/lib/credential-storage-selector.js'

describe('credential-storage-selector', function () {
  describe('getStorageConfig', function () {
    let platformStub: sinon.SinonStub

    beforeEach(function () {
      platformStub = sinon.stub(process, 'platform')
      const env = {...process.env}
      sinon.stub(process, 'env').value(env)
      delete env.HEROKU_NETRC_WRITE
      delete env.HEROKU_KEYCHAIN_WRITE
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

    it('should return native + netrc when HEROKU_NETRC_WRITE and HEROKU_KEYCHAIN_WRITE are true', function () {
      platformStub.value('darwin')
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      process.env.HEROKU_KEYCHAIN_WRITE = 'TRUE'

      const result = getStorageConfig()

      expect(result.credentialStore).to.equal(CredentialStore.MacOSKeychain)
      expect(result.useNetrc).to.be.true
    })

    it('should return native without netrc when HEROKU_KEYCHAIN_WRITE is true', function () {
      platformStub.value('darwin')
      process.env.HEROKU_KEYCHAIN_WRITE = 'TRUE'

      const result = getStorageConfig()

      expect(result.credentialStore).to.equal(CredentialStore.MacOSKeychain)
      expect(result.useNetrc).to.be.false
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

  describe('getNativeCredentialStore', function () {
    let platformStub: sinon.SinonStub

    beforeEach(function () {
      platformStub = sinon.stub(process, 'platform')
      const env = {...process.env}
      sinon.stub(process, 'env').value(env)
      delete env.HEROKU_NETRC_WRITE
      delete env.HEROKU_KEYCHAIN_WRITE
    })

    afterEach(function () {
      sinon.restore()
    })

    it('returns macOS Keychain on darwin even when HEROKU_NETRC_WRITE is true', function () {
      platformStub.value('darwin')
      process.env.HEROKU_NETRC_WRITE = 'TRUE'

      expect(getNativeCredentialStore()).to.equal(CredentialStore.MacOSKeychain)
      expect(getStorageConfig().credentialStore).to.be.null
    })

    it('returns Windows store on win32 regardless of HEROKU_NETRC_WRITE', function () {
      platformStub.value('win32')
      process.env.HEROKU_NETRC_WRITE = 'TRUE'

      expect(getNativeCredentialStore()).to.equal(CredentialStore.WindowsCredentialManager)
    })

    it('returns Linux Secret Service when secret-tool exists', function () {
      platformStub.value('linux')
      const execSyncStub = sinon.stub(childProcess, 'execSync')
      execSyncStub.returns(Buffer.from('/usr/bin/secret-tool\n'))

      expect(getNativeCredentialStore()).to.equal(CredentialStore.LinuxSecretService)
    })

    it('returns null on linux when secret-tool is missing', function () {
      platformStub.value('linux')
      const execSyncStub = sinon.stub(childProcess, 'execSync')
      execSyncStub.throws(new Error('secret-tool not found'))

      expect(getNativeCredentialStore()).to.be.null
    })

    it('returns null on unsupported platforms', function () {
      platformStub.value('freebsd')

      expect(getNativeCredentialStore()).to.be.null
    })
  })
})
