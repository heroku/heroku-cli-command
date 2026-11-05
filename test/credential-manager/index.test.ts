import {expect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'
import childProcess from 'node:child_process'
import sinon from 'sinon'
import {stderr} from 'stdout-stderr'

import {LinuxHandler} from '../../src/credential-manager-core/credential-handlers/linux-handler.js'
import {MacOSHandler} from '../../src/credential-manager-core/credential-handlers/macos-handler.js'
import {NetrcHandler} from '../../src/credential-manager-core/credential-handlers/netrc-handler.js'
import {WindowsHandler} from '../../src/credential-manager-core/credential-handlers/windows-handler.js'
import * as credentialManager from '../../src/credential-manager-core/index.js'
import {credentialSentrySdk} from '../../src/credential-manager-core/lib/cli-command-telemetry.js'
import {CredentialStore} from '../../src/credential-manager-core/lib/credential-storage-selector.js'
import {unwrap} from '../helpers/unwrap.js'

use(chaiAsPromised)

const runSubprocess = childProcess.spawnSync.bind(childProcess)
const mixedSearchItemsDbusLoader = `data:text/javascript,${encodeURIComponent(`
  const mockModule = ${JSON.stringify(`
    import {EventEmitter} from 'node:events'
    export class Message { constructor() {} }
    export function sessionBus() {
      const bus = new EventEmitter()
      return Object.assign(bus, {
        call() {
          return Promise.resolve({body: [
            ['/org/freedesktop/secrets/item/unlocked'],
            ['/org/freedesktop/secrets/item/locked'],
          ]})
        },
        disconnect() {},
      })
    }
  `)}
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === '@jellybrick/dbus-next') {
      return {url: 'data:text/javascript,' + encodeURIComponent(mockModule), shortCircuit: true}
    }
    return nextResolve(specifier, context)
  }
`)}`

function stubNativeGetAuth(platform: 'linux' | 'win32') {
  return platform === 'linux'
    ? sinon.stub(LinuxHandler.prototype, 'getAuthIfAvailable')
    : sinon.stub(WindowsHandler.prototype, 'getAuthIfAvailable')
}

describe('credential-manager', function () {
  function stubCredentialTelemetry() {
    process.env.NODE_ENV = 'production'
    delete process.env.CI
    delete process.env.IS_HEROKU_TEST_ENV
    delete process.env.DISABLE_TELEMETRY

    const client = {close: sinon.stub().resolves()}
    const initStub = sinon.stub(credentialSentrySdk, 'init').returns(client as never)
    const captureExceptionStub = sinon.stub(credentialSentrySdk, 'captureException')
    const flushStub = sinon.stub(credentialSentrySdk, 'flush').resolves(true)
    const getClientStub = sinon.stub(credentialSentrySdk, 'getClient')
      .onSecondCall().returns(client as never)

    return {
      captureExceptionStub,
      client,
      flushStub,
      getClientStub,
      initStub,
    }
  }

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
    it('should save to credential store only', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').resolves()

      await credentialManager.saveAuth('user@example.com', 'test-token', ['api.heroku.com'])

      expect(macosStub.calledOnce).to.be.true
      expect(macosStub.firstCall.args[0]).to.deep.equal({
        account: 'user@example.com',
        service: 'heroku-cli',
        token: 'test-token',
      })
      expect(netrcStub.notCalled).to.be.true
    })

    it('should save to netrc-only when HEROKU_NETRC_WRITE is true', async function () {
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').resolves()

      await credentialManager.saveAuth('user@example.com', 'test-token', ['api.heroku.com'])

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should fall back to netrc if credential store fails', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth').throws(new Error('Keychain error'))
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').resolves()

      await credentialManager.saveAuth('user@example.com', 'test-token', ['api.heroku.com'])

      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should throw an error when netrc fallback fails', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth').throws(new Error('Keychain error'))
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').throws(new Error('Netrc error'))

      await expect(credentialManager.saveAuth('user@example.com', 'test-token', ['api.heroku.com']))
        .to.be.rejectedWith(Error, 'Netrc error')
      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should save to credential store with custom service name', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'saveAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'saveAuthForHosts').resolves()

      await credentialManager.saveAuth('user@example.com', 'test-token', ['api.heroku.com'], 'custom-service')

      expect(macosStub.args[0][0]).to.deep.equal({
        account: 'user@example.com',
        service: 'custom-service',
        token: 'test-token',
      })
      expect(netrcStub.notCalled).to.be.true
    })
  })

  describe('getAuth', function () {
    const missingCredentialPlatforms = [
      {command: 'security find-generic-password', name: 'macOS', platform: 'darwin'},
      {command: 'PasswordVault', name: 'Windows', platform: 'win32'},
    ] as const

    for (const {command, name, platform} of missingCredentialPlatforms) {
      it(`should fall back to netrc without telemetry when ${name} handler reports a missing credential`, async function () {
        Object.defineProperty(process, 'platform', {configurable: true, value: platform})

        const missingCredentialError = Object.assign(new Error('Credential not found'), {status: 44})
        const execSyncStub = sinon.stub(childProcess, 'execSync').throws(missingCredentialError)
        const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
          .resolves({login: 'user@example.com', password: 'netrc-token'})
        const {captureExceptionStub, client, flushStub, getClientStub, initStub} = stubCredentialTelemetry()

        const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

        expect(execSyncStub.calledOnce).to.be.true
        expect(execSyncStub.firstCall.args[0]).to.contain(command)
        if (platform === 'win32') {
          expect(execSyncStub.firstCall.args[1]).to.have.property('shell', 'powershell')
        }

        expect(netrcStub.calledOnceWith('api.heroku.com')).to.be.true
        expect(initStub.notCalled).to.be.true
        expect(captureExceptionStub.notCalled).to.be.true
        expect(flushStub.notCalled).to.be.true
        expect(getClientStub.notCalled).to.be.true
        expect(client.close.notCalled).to.be.true
        expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
      })
    }

    const dispatcherPlatforms = [
      {name: 'Linux', platform: 'linux', store: CredentialStore.LinuxSecretService},
      {name: 'Windows', platform: 'win32', store: CredentialStore.WindowsCredentialManager},
    ] as const

    for (const {name, platform, store} of dispatcherPlatforms) {
      describe(`${name} dispatcher`, function () {
        beforeEach(function () {
          Object.defineProperty(process, 'platform', {configurable: true, value: platform})

          if (platform === 'linux') {
            // Keep the native Linux backend selected independently of the test host.
            sinon.stub(childProcess, 'execSync').returns('secret-tool' as never)
          }
        })

        it('should fall back to netrc without reporting a native miss', async function () {
          const nativeStub = stubNativeGetAuth(platform)
          nativeStub.returns(undefined as never)
          const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
            .resolves({login: 'user@example.com', password: 'netrc-token'})
          const {captureExceptionStub, initStub} = stubCredentialTelemetry()

          const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

          expect(nativeStub.calledOnceWith('user@example.com', 'heroku-cli')).to.be.true
          expect(netrcStub.calledOnceWith('api.heroku.com')).to.be.true
          expect(initStub.notCalled).to.be.true
          expect(captureExceptionStub.notCalled).to.be.true
          expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
        })

        it('should use getAuthIfAvailable to distinguish native misses from errors', async function () {
          const nativeStub = stubNativeGetAuth(platform)
          nativeStub.returns('native-token' as never)

          const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

          expect(nativeStub.calledOnceWith('user@example.com', 'heroku-cli')).to.be.true
          expect(auth).to.deep.equal({account: 'user@example.com', token: 'native-token'})
        })

        it('should reject when the native store misses and netrc has no auth', async function () {
          const nativeStub = stubNativeGetAuth(platform)
          nativeStub.returns(undefined as never)
          const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
            .rejects(new Error('No auth found for api.heroku.com'))
          const {captureExceptionStub, initStub} = stubCredentialTelemetry()

          await expect(credentialManager.getAuth('user@example.com', 'api.heroku.com'))
            .to.be.rejectedWith(Error, 'No auth found for api.heroku.com')

          expect(nativeStub.calledOnce).to.be.true
          expect(netrcStub.calledOnce).to.be.true
          expect(initStub.notCalled).to.be.true
          expect(captureExceptionStub.notCalled).to.be.true
        })

        it('should report native store errors and still fall back to netrc', async function () {
          const nativeError = new Error(`${name} credential store unavailable`)
          const nativeStub = stubNativeGetAuth(platform)
          nativeStub.throws(nativeError)
          const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
            .resolves({login: 'user@example.com', password: 'netrc-token'})
          const {captureExceptionStub, initStub} = stubCredentialTelemetry()

          const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

          expect(nativeStub.calledOnce).to.be.true
          expect(netrcStub.calledOnceWith('api.heroku.com')).to.be.true
          expect(initStub.calledOnce).to.be.true
          expect(captureExceptionStub.calledOnceWith(nativeError, {
            tags: {
              component: 'heroku-cli-command',
              credential_operation: 'getAuth',
              credential_store: store,
            },
          })).to.be.true
          expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
        })

        it('should return native credentials without consulting netrc', async function () {
          const nativeStub = stubNativeGetAuth(platform)
          nativeStub.returns('native-token' as never)
          const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')

          const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

          expect(nativeStub.calledOnceWith('user@example.com', 'heroku-cli')).to.be.true
          expect(netrcStub.notCalled).to.be.true
          expect(auth).to.deep.equal({account: 'user@example.com', token: 'native-token'})
        })
      })
    }

    it('should report a Linux mixed locked and unlocked match, skip lookup, and fall back', async function () {
      Object.defineProperty(process, 'platform', {configurable: true, value: 'linux'})
      sinon.stub(childProcess, 'execSync').returns('secret-tool' as never)

      // Run the real helper with a controlled D-Bus reply so it classifies the mixed arrays itself.
      const helperStub = sinon.stub(childProcess, 'execFileSync').callsFake((file, args, options) => {
        expect(file).to.equal(process.execPath)

        const result = runSubprocess(file, ['--no-warnings', '--loader', mixedSearchItemsDbusLoader, ...args], {
          encoding: 'utf8',
          env: options?.env,
          input: options?.input,
          killSignal: options?.killSignal,
          maxBuffer: options?.maxBuffer,
          stdio: options?.stdio,
          timeout: options?.timeout,
        })
        if (result.error) throw result.error
        if (result.status !== 0) throw new Error('Linux keyring helper failed')
        return result.stdout as never
      })
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
        .resolves({login: 'user@example.com', password: 'netrc-token'})
      const {captureExceptionStub, initStub} = stubCredentialTelemetry()

      const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(helperStub.calledOnce).to.be.true
      expect(helperStub.callCount).to.equal(1)
      expect(helperStub.returnValues[0]).to.equal('{"status":"locked-match"}')
      expect(helperStub.firstCall.args[1][0]).to.contain('linux-keyring-search.mjs')
      expect(helperStub.firstCall.args[1]).to.not.include('lookup')
      expect(captureExceptionStub.calledOnce).to.be.true
      expect(captureExceptionStub.firstCall.args[0]).to.have.property('message', 'Failed to retrieve token from Linux keyring: keyring is locked')
      expect(netrcStub.calledOnceWith('api.heroku.com')).to.be.true
      expect(initStub.calledOnce).to.be.true
      expect(captureExceptionStub.firstCall.args[1]).to.deep.equal({
        tags: {
          component: 'heroku-cli-command',
          credential_operation: 'getAuth',
          credential_store: CredentialStore.LinuxSecretService,
        },
      })
      expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
    })

    it('should report a Linux locked-only match, skip lookup, and fall back', async function () {
      Object.defineProperty(process, 'platform', {configurable: true, value: 'linux'})
      sinon.stub(childProcess, 'execSync').returns('secret-tool' as never)

      // A locked-only SearchItems reply is also represented by locked-match.
      const helperStub = sinon.stub(childProcess, 'execFileSync').returns(JSON.stringify({status: 'locked-match'}) as never)
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
        .resolves({login: 'user@example.com', password: 'netrc-token'})
      const {captureExceptionStub, initStub} = stubCredentialTelemetry()

      const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(helperStub.calledOnce).to.be.true
      expect(helperStub.firstCall.args[0]).to.equal(process.execPath)
      expect(helperStub.firstCall.args[1][0]).to.contain('linux-keyring-search.mjs')
      expect(helperStub.firstCall.args[1]).to.not.include('lookup')
      expect(captureExceptionStub.calledOnce).to.be.true
      expect(captureExceptionStub.firstCall.args[0]).to.have.property('message', 'Failed to retrieve token from Linux keyring: keyring is locked')
      expect(netrcStub.calledOnceWith('api.heroku.com')).to.be.true
      expect(initStub.calledOnce).to.be.true
      expect(captureExceptionStub.firstCall.args[1]).to.deep.equal({
        tags: {
          component: 'heroku-cli-command',
          credential_operation: 'getAuth',
          credential_store: CredentialStore.LinuxSecretService,
        },
      })
      expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
    })

    it('should retrieve from credential store when available', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuthIfAvailable').returns('keychain-token')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')

      const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(auth).to.deep.equal({account: 'user@example.com', token: 'keychain-token'})
      expect(macosStub.calledOnce).to.be.true
      expect(macosStub.firstCall.args[0]).to.equal('user@example.com')
      expect(macosStub.firstCall.args[1]).to.equal('heroku-cli')
      expect(netrcStub.notCalled).to.be.true
    })

    it('should fall back to netrc when credential store returns undefined', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuthIfAvailable').returns()
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
        .resolves({login: 'user@example.com', password: 'netrc-token'})
      const {captureExceptionStub, initStub} = stubCredentialTelemetry()

      const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(initStub.notCalled).to.be.true
      expect(captureExceptionStub.notCalled).to.be.true
      expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
    })

    it('should reject when credential store returns undefined and netrc has no auth', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuthIfAvailable').returns()
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
        .rejects(new Error('No auth found for api.heroku.com'))

      await expect(credentialManager.getAuth('user@example.com', 'api.heroku.com'))
        .to.be.rejectedWith(Error, 'No auth found for api.heroku.com')
      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should retrieve from netrc-only when HEROKU_NETRC_WRITE is true', async function () {
      process.env.HEROKU_NETRC_WRITE = 'TRUE'
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuthIfAvailable')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth').resolves({login: 'user@example.com', password: 'netrc-token'})

      const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(netrcStub.firstCall.args[0]).to.equal('api.heroku.com')
      expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
    })

    it('should fall back to netrc if credential store fails', async function () {
      const nativeError = new Error('Keychain error')
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuthIfAvailable').throws(nativeError)
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
      netrcStub.resolves({login: 'user@example.com', password: 'netrc-token'})
      const {captureExceptionStub, client, flushStub, getClientStub, initStub} = stubCredentialTelemetry()

      const auth = await credentialManager.getAuth('user@example.com', 'api.heroku.com')

      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(initStub.calledOnce).to.be.true
      expect(captureExceptionStub.calledOnce).to.be.true
      expect(captureExceptionStub.firstCall.args[0]).to.equal(nativeError)
      expect(captureExceptionStub.firstCall.args[1]).to.deep.equal({
        tags: {
          component: 'heroku-cli-command',
          credential_operation: 'getAuth',
          credential_store: CredentialStore.MacOSKeychain,
        },
      })
      expect(flushStub.calledOnceWith(2000)).to.be.true
      expect(getClientStub.calledTwice).to.be.true
      expect(client.close.calledOnce).to.be.true
      expect(netrcStub.firstCall.args[0]).to.equal('api.heroku.com')
      expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
    })

    it('should throw error when credentials are not found in either location', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuthIfAvailable').throws(new Error('Not found'))
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
      netrcStub.rejects(new Error('No auth found for api.heroku.com'))

      await expect(credentialManager.getAuth('user@example.com', 'api.heroku.com'))
        .to.be.rejectedWith(Error, 'No auth found for api.heroku.com')
      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should throw error when netrc password is empty', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuthIfAvailable').throws(new Error('Not found'))
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
      netrcStub.resolves({login: 'user@example.com', password: undefined})

      await expect(credentialManager.getAuth('user@example.com', 'api.heroku.com'))
        .to.be.rejectedWith(Error, 'No auth found')
      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
    })

    it('should fall back to netrc when an account is not provided', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuthIfAvailable')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'getAuth')
      netrcStub.resolves({login: 'user@example.com', password: 'netrc-token'})

      stderr.start()

      const auth = await credentialManager.getAuth(undefined, 'api.heroku.com')

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})

      stderr.stop()
    })

    it('should retrieve from credential store with custom service name', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'getAuthIfAvailable').returns('keychain-token')
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

    it('should remove from both stores even when HEROKU_NETRC_WRITE is true', async function () {
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

      await credentialManager.removeAuth('user@example.com', ['api.heroku.com'])

      expect(macosStub.calledOnce).to.be.true
      expect(netrcStub.calledOnce).to.be.true
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

    it('should continue to netrc if account is undefined without native removal or warnings', async function () {
      const macosStub = sinon.stub(MacOSHandler.prototype, 'removeAuth')
      const netrcStub = sinon.stub(NetrcHandler.prototype, 'removeAuthForHosts').resolves()

      stderr.start()
      await credentialManager.removeAuth(undefined, ['api.heroku.com'])

      expect(macosStub.notCalled).to.be.true
      expect(netrcStub.calledOnce).to.be.true
      expect(unwrap(stderr.output)).to.not.contain('We can\'t remove the Heroku token from your computer\'s keychain.')

      stderr.stop()
    })
  })

  describe('listKeychainAccounts', function () {
    it('should return accounts from the native credential store', async function () {
      sinon.stub(MacOSHandler.prototype, 'listAccounts').returns(['user1@example.com', 'user2@example.com'])

      const accounts = await credentialManager.listKeychainAccounts()

      expect(accounts).to.deep.equal(['user1@example.com', 'user2@example.com'])
    })

    it('should pass a custom service name to the handler', async function () {
      const listStub = sinon.stub(MacOSHandler.prototype, 'listAccounts').returns(['user@example.com'])

      await credentialManager.listKeychainAccounts('custom-service')

      expect(listStub.calledOnceWith('custom-service')).to.be.true
    })

    it('should return an empty array when no native credential store is available', async function () {
      process.env.HEROKU_NETRC_WRITE = 'TRUE'

      const accounts = await credentialManager.listKeychainAccounts()

      expect(accounts).to.deep.equal([])
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
