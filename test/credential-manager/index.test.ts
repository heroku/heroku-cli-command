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

      const token = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(token).to.equal('keychain-token')
      expect(macosStub.calledOnce).to.be.true
      expect(macosStub.firstCall.args[0]).to.equal('user@example.com')
      expect(macosStub.firstCall.args[1]).to.equal('heroku-cli')
      expect(netrcStub.notCalled).to.be.true
    })

    it('should retrieve from netrc-only when credential store is disabled', async function () {
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth').resolves({login: 'user@example.com', password: 'netrc-token'})

      const token = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(netrcStub.firstCall.args[0]).to.equal('api.heroku.com')
      expect(token).to.equal('netrc-token')
    })

    it('should fall back to netrc if credential store fails', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth').throws(new Error('Keychain error'))
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
      netrcStub.resolves({login: 'user@example.com', password: 'netrc-token'})

      stderr.start()

      const token = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(token).to.equal('netrc-token')
      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(netrcStub.firstCall.args[0]).to.equal('api.heroku.com')
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

      const token = await credentialManager.getAuth(undefined, 'api.heroku.com')

      expect(listAccountsStub.calledOnce).to.be.true
      expect(listAccountsStub.firstCall.args[0]).to.equal('heroku-cli')
      expect(getAuthStub.calledOnce).to.be.true
      expect(getAuthStub.firstCall.args[0]).to.equal('user@example.com')
      expect(netrcStub.notCalled).to.be.true
      expect(token).to.equal('keychain-token')
    })

    it('should use the selected account when an account is not provided and multiple accounts are found', async function () {
      const listAccountsStub = sinon.stub(MacOSHandler.prototype, 'listAccounts').returns(['user1@example.com', 'user2@example.com'])
      const promptStub = (sinon.stub(inquirer, 'prompt')).resolves({account: 'user2@example.com'})
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth').returns('keychain-token')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')

      const token = await credentialManager.getAuth(undefined, 'api.heroku.com')

      expect(listAccountsStub.calledOnce).to.be.true
      expect(promptStub.calledOnce).to.be.true
      expect(macosStub.calledOnce).to.be.true
      expect(macosStub.firstCall.args[0]).to.equal('user2@example.com')
      expect(netrcStub.notCalled).to.be.true
      expect(token).to.equal('keychain-token')
    })

    it('should fall back to netrc when an account is not provided and no accounts are found', async function () {
      sinon.stub(MacOSHandler.prototype, 'listAccounts').returns([])
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
      netrcStub.resolves({login: 'user@example.com', password: 'netrc-token'})

      const token = await credentialManager.getAuth(undefined, 'api.heroku.com')

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(token).to.equal('netrc-token')
    })

    it('should fall back to netrc when an account is not provided and listAccounts fails', async function () {
      sinon.stub(MacOSHandler.prototype, 'listAccounts').throws(new Error('Keychain error'))
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
      netrcStub.resolves({login: 'user@example.com', password: 'netrc-token'})

      stderr.start()

      const token = await credentialManager.getAuth(undefined, 'api.heroku.com')

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(token).to.equal('netrc-token')
      expect(unwrap(stderr.output)).to.contain('Warning: We can’t retrieve the Heroku token from heroku-cli.')
      expect(unwrap(stderr.output)).to.contain('We\'ll try to retrieve the token from the .netrc file instead.')
      expect(unwrap(stderr.output)).to.contain('To turn off this warning, set HEROKU_KEYCHAIN_WARNINGS to "off".')

      stderr.stop()
    })

    it('should retrieve from credential store with custom service name', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuth').returns('keychain-token')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')

      await credentialManager.getAuth('user@example.com', 'api.heroku.com', 'custom-service')

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

    it('should remove from netrc-only when credential store is disabled', async function () {
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      await credentialManager.removeAuth('user@example.com', ['api.heroku.com'])

      expect(macosStub.notCalled).to.be.true
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

    it('should use the selected account when an account is not provided', async function () {
      const listAccountsStub = sinon.stub(MacOSHandler.prototype, 'listAccounts').returns(['user@example.com'])
      const removeAuthStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      await credentialManager.removeAuth(undefined, ['api.heroku.com'])

      expect(listAccountsStub.calledOnce).to.be.true
      expect(listAccountsStub.firstCall.args[0]).to.equal('heroku-cli')
      expect(removeAuthStub.calledOnce).to.be.true
      expect(removeAuthStub.firstCall.args[0]).to.equal('user@example.com')
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should use the selected account when an account is not provided and multiple accounts are found', async function () {
      const listAccountsStub = sinon.stub(MacOSHandler.prototype, 'listAccounts').returns(['user1@example.com', 'user2@example.com'])
      const promptStub = (sinon.stub(inquirer, 'prompt')).resolves({account: 'user2@example.com'})
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      await credentialManager.removeAuth(undefined, ['api.heroku.com'])

      expect(listAccountsStub.calledOnce).to.be.true
      expect(promptStub.calledOnce).to.be.true
      expect(macosStub.calledOnce).to.be.true
      expect(macosStub.firstCall.args[0]).to.equal('user2@example.com')
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should continue to netrc when an account is not provided and no accounts are found', async function () {
      sinon.stub(MacOSHandler.prototype, 'listAccounts').returns([])
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      await credentialManager.removeAuth(undefined, ['api.heroku.com'])

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should continue to netrc when an account is not provided and listAccounts fails', async function () {
      sinon.stub(MacOSHandler.prototype, 'listAccounts').throws(new Error('Keychain error'))
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

    it('should remove from credential store with custom service name', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      await credentialManager.removeAuth('user@example.com', ['api.heroku.com'], 'custom-service')

      expect(macosStub.args[0][1]).to.equal('custom-service')
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
})
