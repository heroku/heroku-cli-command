import {expect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'
import inquirer from 'inquirer'
import sinon from 'sinon'
import {stderr} from 'stdout-stderr'

import {LinuxHandler} from '../../src/credential-manager-core/credential-handlers/linux-handler.js'
import {MacOSHandler} from '../../src/credential-manager-core/credential-handlers/macos-handler.js'
import {NetrcHandler} from '../../src/credential-manager-core/credential-handlers/netrc-handler.js'
import {WindowsHandler} from '../../src/credential-manager-core/credential-handlers/windows-handler.js'
import * as credentialManager from '../../src/credential-manager-core/index.js'
import {CredentialStore} from '../../src/credential-manager-core/lib/credential-storage-selector.js'
import {unwrap} from '../helpers/unwrap.js'

use(chaiAsPromised)

describe('credential-manager', function () {
  // default to use macOS platform for testing
  beforeEach(function () {
    sinon.stub(process, 'platform').value('darwin')

    const env = {...process.env}
    sinon.stub(process, 'env').value(env)

    delete env.HEROKU_NETRC_WRITE
  })

  afterEach(function () {
    sinon.restore()
  })

  describe('saveAuth', function () {
    it('should save to both credential store and netrc', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').resolves()

      await credentialManager.saveAuth('user@example.com', 'test-token', ['api.heroku.com'])

      expect(macosStub.calledOnce).to.be.true
      expect(macosStub.firstCall.args[0]).to.deep.equal({
        account: 'user@example.com',
        service: 'heroku-cli',
        token: 'test-token',
      })
      expect(netrcStub.calledOnce).to.be.true
      expect(netrcStub.firstCall.args[0]).to.deep.equal({
        login: 'user@example.com',
        password: 'test-token',
      })
      expect(netrcStub.firstCall.args[1]).to.deep.equal(['api.heroku.com'])
    })

    it('should save to netrc-only when credential store is disabled', async function () {
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').resolves()

      await credentialManager.saveAuth('user@example.com', 'test-token', ['api.heroku.com'])

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should continue to netrc if credential store fails', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth').throws(new Error('Keychain error'))
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').resolves()

      stderr.start()
      await credentialManager.saveAuth('user@example.com', 'test-token', ['api.heroku.com'])

      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(unwrap(stderr.output)).to.contain('Warning: We can’t save the Heroku token to heroku-cli.')
      expect(unwrap(stderr.output)).to.contain('We\'ll save the token to the .netrc file instead.')
      expect(unwrap(stderr.output)).to.contain('To turn off this warning, set HEROKU_KEYCHAIN_WARNINGS to "off".')

      stderr.stop()
    })

    it('should save to credential store once and netrc once for multiple hosts', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').resolves()

      await credentialManager.saveAuth('user@example.com', 'test-token', ['api.heroku.com', 'git.heroku.com'])

      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(netrcStub.firstCall.args[1]).to.deep.equal(['api.heroku.com', 'git.heroku.com'])
    })

    it('should throw an error when netrc fails to save', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').throws(new Error('Netrc error'))

      await expect(credentialManager.saveAuth('user@example.com', 'test-token', ['api.heroku.com']))
        .to.be.rejectedWith(Error, 'Netrc error')
      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should save to credential store with custom service name', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth')
      sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').resolves()

      await credentialManager.saveAuth('user@example.com', 'test-token', ['api.heroku.com'], 'custom-service')

      expect(macosStub.args[0][0]).to.deep.equal({
        account: 'user@example.com',
        service: 'custom-service',
        token: 'test-token',
      })
    })
  })

  describe('getAuth', function () {
    it('should retrieve from credential store when available', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth').returns('keychain-token')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')

      const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(auth).to.deep.equal({account: 'user@example.com', token: 'keychain-token'})
      expect(macosStub.calledOnce).to.be.true
      expect(macosStub.firstCall.args[0]).to.equal('user@example.com')
      expect(macosStub.firstCall.args[1]).to.equal('heroku-cli')
      expect(netrcStub.notCalled).to.be.true
    })

    it('should retrieve from netrc-only when credential store is disabled', async function () {
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth').resolves({login: 'user@example.com', password: 'netrc-token'})

      const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(netrcStub.firstCall.args[0]).to.equal('api.heroku.com')
      expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
    })

    it('should fall back to netrc if credential store fails', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth').throws(new Error('Keychain error'))
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
      netrcStub.resolves({login: 'user@example.com', password: 'netrc-token'})

      stderr.start()

      const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(netrcStub.firstCall.args[0]).to.equal('api.heroku.com')
      expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
      expect(unwrap(stderr.output)).to.contain('Warning: We can’t retrieve the Heroku token from heroku-cli.')
      expect(unwrap(stderr.output)).to.contain('We\'ll try to retrieve the token from the .netrc file instead.')
      expect(unwrap(stderr.output)).to.contain('To turn off this warning, set HEROKU_KEYCHAIN_WARNINGS to "off".')

      stderr.stop()
    })

    it('should throw error when credentials are not found in either location', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth').throws(new Error('Not found'))
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
      netrcStub.rejects(new Error('No auth found for api.heroku.com'))

      stderr.start()

      await expect(credentialManager.getAuth('user@example.com', 'api.heroku.com'))
        .to.be.rejectedWith(Error, 'No auth found for api.heroku.com')
      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(unwrap(stderr.output)).to.contain('Warning: We can’t retrieve the Heroku token from heroku-cli.')
      expect(unwrap(stderr.output)).to.contain('We\'ll try to retrieve the token from the .netrc file instead.')
      expect(unwrap(stderr.output)).to.contain('To turn off this warning, set HEROKU_KEYCHAIN_WARNINGS to "off".')

      stderr.stop()
    })

    it('should throw error when netrc password is empty', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth').throws(new Error('Not found'))
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
      netrcStub.resolves({login: 'user@example.com', password: undefined})

      stderr.start()

      await expect(credentialManager.getAuth('user@example.com', 'api.heroku.com'))
        .to.be.rejectedWith(Error, 'No credentials found. Please log in.')
      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(unwrap(stderr.output)).to.contain('Warning: We can’t retrieve the Heroku token from heroku-cli.')
      expect(unwrap(stderr.output)).to.contain('We\'ll try to retrieve the token from the .netrc file instead.')
      expect(unwrap(stderr.output)).to.contain('To turn off this warning, set HEROKU_KEYCHAIN_WARNINGS to "off".')

      stderr.stop()
    })

    it('should use the selected account when an account is not provided', async function () {
      const listAccountsStub = sinon.stub(MacOSHandler.prototype, 'listAccounts').returns(['user@example.com'])
      const getAuthStub = sinon.stub(MacOSHandler.prototype, 'getAuth').returns('keychain-token')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')

      const auth = await credentialManager.getAuth(undefined, 'api.heroku.com')

      expect(listAccountsStub.calledOnce).to.be.true
      expect(listAccountsStub.firstCall.args[0]).to.equal('heroku-cli')
      expect(getAuthStub.calledOnce).to.be.true
      expect(netrcStub.notCalled).to.be.true
      expect(auth).to.deep.equal({account: 'user@example.com', token: 'keychain-token'})
    })

    it('should use the selected account when an account is not provided and multiple accounts are found', async function () {
      const listAccountsStub = sinon.stub(MacOSHandler.prototype, 'listAccounts').returns(['user1@example.com', 'user2@example.com'])
      const promptStub = (sinon.stub(inquirer, 'prompt')).resolves({account: 'user2@example.com'})
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth').returns('keychain-token')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')

      const auth = await credentialManager.getAuth(undefined, 'api.heroku.com')

      expect(listAccountsStub.calledOnce).to.be.true
      expect(promptStub.calledOnce).to.be.true
      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.notCalled).to.be.true
      expect(auth).to.deep.equal({account: 'user2@example.com', token: 'keychain-token'})
    })

    it('should fall back to netrc when an account is not provided and no accounts are found', async function () {
      sinon.stub(MacOSHandler.prototype, 'listAccounts').returns([])
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
      netrcStub.resolves({login: 'user@example.com', password: 'netrc-token'})

      const auth = await credentialManager.getAuth(undefined, 'api.heroku.com')

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
    })

    it('should fall back to netrc when an account is not provided and listAccounts fails', async function () {
      sinon.stub(MacOSHandler.prototype, 'listAccounts').throws(new Error('Keychain error'))
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
      netrcStub.resolves({login: 'user@example.com', password: 'netrc-token'})

      stderr.start()

      const auth = await credentialManager.getAuth(undefined, 'api.heroku.com')

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
      expect(unwrap(stderr.output)).to.contain('Warning: We can’t retrieve the Heroku token from heroku-cli.')
      expect(unwrap(stderr.output)).to.contain('We\'ll try to retrieve the token from the .netrc file instead.')
      expect(unwrap(stderr.output)).to.contain('To turn off this warning, set HEROKU_KEYCHAIN_WARNINGS to "off".')

      stderr.stop()
    })

    it('should retrieve from credential store with custom service name', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth').returns('keychain-token')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')

      const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com', 'custom-service')

      expect(auth).to.deep.equal({account: 'user@example.com', token: 'keychain-token'})
      expect(macosStub.args[0][1]).to.equal('custom-service')
      expect(netrcStub.notCalled).to.be.true
    })
  })

  describe('removeAuth', function () {
    it('should remove from both credential store and netrc', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      await credentialManager.removeAuth('user@example.com', ['api.heroku.com'])

      expect(macosStub.calledOnce).to.be.true
      expect(macosStub.firstCall.args[0]).to.equal('user@example.com')
      expect(macosStub.firstCall.args[1]).to.equal('heroku-cli')
      expect(netrcStub.calledOnce).to.be.true
      expect(netrcStub.firstCall.args[0]).to.deep.equal(['api.heroku.com'])
    })

    it('should still remove from native store when HEROKU_NETRC_WRITE disables save path', async function () {
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      await credentialManager.removeAuth('user@example.com', ['api.heroku.com'])

      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should continue to netrc if credential store fails', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth').throws(new Error('Keychain error'))
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      stderr.start()
      await credentialManager.removeAuth('user@example.com', ['api.heroku.com'])

      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(unwrap(stderr.output)).to.contain('Warning: We can’t remove the Heroku token from heroku-cli.')
      expect(unwrap(stderr.output)).to.contain('We\'ll remove the token from the .netrc file instead.')
      expect(unwrap(stderr.output)).to.contain('To turn off this warning, set HEROKU_KEYCHAIN_WARNINGS to "off".')

      stderr.stop()
    })

    it('should remove from credential store once and netrc once for multiple hosts', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      await credentialManager.removeAuth('user@example.com', ['api.heroku.com', 'git.heroku.com'])

      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(netrcStub.firstCall.args[0]).to.deep.equal(['api.heroku.com', 'git.heroku.com'])
    })

    it('should throw an error when netrc fails to remove', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').throws(new Error('Netrc error'))

      await expect(credentialManager.removeAuth('user@example.com', ['api.heroku.com']))
        .to.be.rejectedWith(Error, 'Netrc error')
      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should remove from credential store with custom service name', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      await credentialManager.removeAuth('user@example.com', ['api.heroku.com'], 'custom-service')

      expect(macosStub.args[0][1]).to.equal('custom-service')
    })

    it('should continue to netrc if account is undefined', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      stderr.start()
      await credentialManager.removeAuth(undefined, ['api.heroku.com'])

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(unwrap(stderr.output)).to.contain('Warning: We can’t remove the Heroku token from heroku-cli.')
      expect(unwrap(stderr.output)).to.contain('We\'ll remove the token from the .netrc file instead.')
      expect(unwrap(stderr.output)).to.contain('To turn off this warning, set HEROKU_KEYCHAIN_WARNINGS to "off".')

      stderr.stop()
    })
  })

  describe('getCredentialHandler', function () {
    it('should return the correct credential handler for the given store', function () {
      let handler = credentialManager.getCredentialHandler(CredentialStore.MacOSKeychain)
      expect(handler).to.be.instanceOf(MacOSHandler)

      handler = credentialManager.getCredentialHandler(CredentialStore.WindowsCredentialManager)
      expect(handler).to.be.instanceOf(WindowsHandler)

      handler = credentialManager.getCredentialHandler(CredentialStore.LinuxSecretService)
      expect(handler).to.be.instanceOf(LinuxHandler)
    })
  })

  describe('saveAuth with HEROKU_KEYCHAIN_WARNINGS', function () {
    it('should not show warning when HEROKU_KEYCHAIN_WARNINGS is "off" and credential store fails', async function () {
      process.env.HEROKU_KEYCHAIN_WARNINGS = 'off'
      sinon.stub(MacOSHandler.prototype, 'saveAuth').throws(new Error('Keychain error'))
      sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').resolves()

      stderr.start()
      await credentialManager.saveAuth('user@example.com', 'test-token', ['api.heroku.com'])

      expect(unwrap(stderr.output)).to.not.contain('Warning:')

      stderr.stop()
    })
  })

  describe('getAuth with HEROKU_KEYCHAIN_WARNINGS', function () {
    it('should not show warning when HEROKU_KEYCHAIN_WARNINGS is "off" and credential store fails', async function () {
      process.env.HEROKU_KEYCHAIN_WARNINGS = 'off'
      sinon.stub(MacOSHandler.prototype, 'getAuth').throws(new Error('Keychain error'))
      sinon.stub(NetrcHandler.prototype, 'getAuth').resolves({login: 'user@example.com', password: 'netrc-token'})

      stderr.start()
      const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
      expect(unwrap(stderr.output)).to.not.contain('Warning:')

      stderr.stop()
    })
  })

  describe('removeAuth with HEROKU_KEYCHAIN_WARNINGS', function () {
    it('should not show warning when HEROKU_KEYCHAIN_WARNINGS is "off" and credential store fails', async function () {
      process.env.HEROKU_KEYCHAIN_WARNINGS = 'off'
      sinon.stub(MacOSHandler.prototype, 'removeAuth').throws(new Error('Keychain error'))
      sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      stderr.start()
      await credentialManager.removeAuth('user@example.com', ['api.heroku.com'])

      expect(unwrap(stderr.output)).to.not.contain('Warning:')

      stderr.stop()
    })
  })

  describe('saveAuth with empty hosts', function () {
    it('should not call netrc when hosts array is empty', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').resolves()

      await credentialManager.saveAuth('user@example.com', 'test-token', [])

      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.notCalled).to.be.true
    })

    it('should not call netrc when hosts array is empty and credential store is disabled', async function () {
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').resolves()

      await credentialManager.saveAuth('user@example.com', 'test-token', [])

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.notCalled).to.be.true
    })
  })

  describe('removeAuth with empty hosts', function () {
    it('should not call netrc when hosts array is empty', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      await credentialManager.removeAuth('user@example.com', [])

      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.notCalled).to.be.true
    })
  })

  describe('getAuth when no credential store is available', function () {
    it('should throw error when netrc-only mode has no credentials', async function () {
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth').resolves({login: 'user@example.com', password: ''})

      await expect(credentialManager.getAuth('user@example.com', 'api.heroku.com'))
        .to.be.rejectedWith(Error, 'No credentials found. Please log in.')
      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should throw error when credential store is disabled and netrc has no password', async function () {
      sinon.stub(process, 'platform').value('darwin')
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      sinon.stub(NetrcHandler.prototype, 'getAuth').resolves({login: 'user@example.com', password: undefined})

      await expect(credentialManager.getAuth(undefined, 'api.heroku.com'))
        .to.be.rejectedWith(Error, 'No credentials found. Please log in.')
    })

    it('should throw error when no credential store and netrc throws error', async function () {
      sinon.stub(process, 'platform').value('darwin')
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      sinon.stub(NetrcHandler.prototype, 'getAuth').rejects(new Error('Netrc read error'))

      await expect(credentialManager.getAuth(undefined, 'api.heroku.com'))
        .to.be.rejectedWith(Error, 'Netrc read error')
    })
  })

  describe('module exports', function () {
    it('should export LinuxHandler', function () {
      const {LinuxHandler: ExportedLinuxHandler} = credentialManager
      expect(ExportedLinuxHandler).to.equal(LinuxHandler)
    })

    it('should export MacOSHandler', function () {
      const {MacOSHandler: ExportedMacOSHandler} = credentialManager
      expect(ExportedMacOSHandler).to.equal(MacOSHandler)
    })

    it('should export NetrcHandler', function () {
      const {NetrcHandler: ExportedNetrcHandler} = credentialManager
      expect(ExportedNetrcHandler).to.equal(NetrcHandler)
    })

    it('should export WindowsHandler', function () {
      const {WindowsHandler: ExportedWindowsHandler} = credentialManager
      expect(ExportedWindowsHandler).to.equal(WindowsHandler)
    })

    it('should export selectAccount', function () {
      const {selectAccount: exportedSelectAccount} = credentialManager
      expect(exportedSelectAccount).to.be.a('function')
    })

    it('should export CredentialStore', function () {
      const {CredentialStore: ExportedCredentialStore} = credentialManager
      expect(ExportedCredentialStore).to.be.an('object')
      expect(ExportedCredentialStore.MacOSKeychain).to.equal('macos-keychain')
      expect(ExportedCredentialStore.WindowsCredentialManager).to.equal('windows-credential-manager')
      expect(ExportedCredentialStore.LinuxSecretService).to.equal('linux-secret-service')
    })

    it('should export getNativeCredentialStore', function () {
      const {getNativeCredentialStore: exportedGetNativeCredentialStore} = credentialManager
      expect(exportedGetNativeCredentialStore).to.be.a('function')
      const result = exportedGetNativeCredentialStore()
      expect(result).to.equal('macos-keychain')
    })

    it('should export getStorageConfig', function () {
      const {getStorageConfig: exportedGetStorageConfig} = credentialManager
      expect(exportedGetStorageConfig).to.be.a('function')
      const result = exportedGetStorageConfig()
      expect(result).to.have.property('credentialStore')
      expect(result).to.have.property('useNetrc')
    })

    it('should export Netrc', function () {
      const {Netrc: ExportedNetrc} = credentialManager
      expect(ExportedNetrc).to.be.a('function')
    })

    it('should export parse', function () {
      const {parse: exportedParse} = credentialManager
      expect(exportedParse).to.be.a('function')
    })
  })

  describe('platform-specific handlers', function () {
    it('should use WindowsHandler on win32 platform', function () {
      sinon.stub(process, 'platform').value('win32')
      const handler = credentialManager.getCredentialHandler(CredentialStore.WindowsCredentialManager)
      expect(handler).to.be.instanceOf(WindowsHandler)
    })

    it('should use LinuxHandler on linux platform', function () {
      sinon.stub(process, 'platform').value('linux')
      const handler = credentialManager.getCredentialHandler(CredentialStore.LinuxSecretService)
      expect(handler).to.be.instanceOf(LinuxHandler)
    })
  })
})
