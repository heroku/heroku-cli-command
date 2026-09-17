import {expect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'
import {restore, stub} from 'sinon'

import {
  credentialSentrySdk,
  reportCredentialStoreError,
  sanitizeCredentialErrorEvent,
  shouldReportCredentialErrorsToSentry,
} from '../../../src/credential-manager-core/lib/cli-command-telemetry.js'
import {CredentialStore} from '../../../src/credential-manager-core/lib/credential-storage-selector.js'

use(chaiAsPromised)

describe('cli-command-telemetry', function () {
  afterEach(function () {
    restore()
    delete process.env.CI
    process.env.NODE_ENV = 'test'
    delete process.env.IS_HEROKU_TEST_ENV
    delete process.env.DISABLE_TELEMETRY
  })

  describe('shouldReportCredentialErrorsToSentry', function () {
    it('returns false when CI is true', function () {
      process.env.CI = 'true'
      process.env.NODE_ENV = 'development'
      expect(shouldReportCredentialErrorsToSentry()).to.equal(false)
    })

    it('returns false when NODE_ENV is test', function () {
      process.env.NODE_ENV = 'test'
      expect(shouldReportCredentialErrorsToSentry()).to.equal(false)
    })

    it('returns false when IS_HEROKU_TEST_ENV is true', function () {
      process.env.IS_HEROKU_TEST_ENV = 'true'
      process.env.NODE_ENV = 'development'
      expect(shouldReportCredentialErrorsToSentry()).to.equal(false)
    })

    it('returns false when DISABLE_TELEMETRY is true', function () {
      process.env.DISABLE_TELEMETRY = 'true'
      process.env.NODE_ENV = 'development'
      expect(shouldReportCredentialErrorsToSentry()).to.equal(false)
    })

    it('returns true when reporting is allowed', function () {
      delete process.env.CI
      process.env.NODE_ENV = 'development'
      delete process.env.IS_HEROKU_TEST_ENV
      delete process.env.DISABLE_TELEMETRY
      expect(shouldReportCredentialErrorsToSentry()).to.equal(true)
    })
  })

  describe('reportCredentialStoreError', function () {
    it('does not capture when CI is set', async function () {
      process.env.CI = 'true'
      process.env.NODE_ENV = 'development'
      const captureStub = stub(credentialSentrySdk, 'captureException')
      const err = new Error('keychain failed')
      await reportCredentialStoreError(err, {
        credentialStore: CredentialStore.MacOSKeychain,
        operation: 'saveAuth',
      })
      expect(captureStub.called).to.equal(false)
    })

    it('does not capture when NODE_ENV is test', async function () {
      process.env.NODE_ENV = 'test'
      const captureStub = stub(credentialSentrySdk, 'captureException')
      await reportCredentialStoreError(new Error('x'), {
        credentialStore: CredentialStore.MacOSKeychain,
        operation: 'getAuth',
      })
      expect(captureStub.called).to.equal(false)
    })

    it('captures with expected tags when reporting is enabled', async function () {
      delete process.env.CI
      process.env.NODE_ENV = 'development'
      delete process.env.IS_HEROKU_TEST_ENV
      delete process.env.DISABLE_TELEMETRY

      const closeStub = stub().resolves()
      stub(credentialSentrySdk, 'getClient').returns({close: closeStub} as unknown as NonNullable<ReturnType<typeof credentialSentrySdk.getClient>>)
      stub(credentialSentrySdk, 'init')
      const captureStub = stub(credentialSentrySdk, 'captureException')
      stub(credentialSentrySdk, 'flush').resolves(true)

      const err = new Error('Failed to retrieve token from macOS Keychain: scrubbed')
      await reportCredentialStoreError(err, {
        credentialStore: CredentialStore.MacOSKeychain,
        operation: 'getAuth',
      })

      expect(captureStub.calledOnce).to.equal(true)
      const reportedError: unknown = captureStub.firstCall.args[0]
      expect(reportedError).to.be.instanceOf(Error)
      if (!(reportedError instanceof Error)) {
        throw new TypeError('expected credential telemetry to capture an Error')
      }

      expect(reportedError.message).to.equal('Credential manager operation failed')
      expect(reportedError.cause).to.equal(undefined)
      expect(captureStub.firstCall.args[1]).to.deep.include({
        tags: {
          component: 'heroku-cli-command',
          credential_operation: 'getAuth',
          credential_store: CredentialStore.MacOSKeychain,
        },
      })
    })

    it('captures a generic error without retaining the provider error', async function () {
      delete process.env.CI
      process.env.NODE_ENV = 'development'
      delete process.env.IS_HEROKU_TEST_ENV
      delete process.env.DISABLE_TELEMETRY

      const closeStub = stub().resolves()
      stub(credentialSentrySdk, 'getClient').returns({close: closeStub} as unknown as NonNullable<ReturnType<typeof credentialSentrySdk.getClient>>)
      const captureStub = stub(credentialSentrySdk, 'captureException')
      stub(credentialSentrySdk, 'flush').resolves(true)

      const providerError = new Error('opaque-account opaque-service opaque-token')
      await reportCredentialStoreError(providerError, {
        credentialStore: CredentialStore.MacOSKeychain,
        operation: 'getAuth',
      })

      const reportedError: unknown = captureStub.firstCall.args[0]
      expect(reportedError).to.be.instanceOf(Error)
      if (!(reportedError instanceof Error)) {
        throw new TypeError('expected credential telemetry to capture an Error')
      }

      expect(reportedError.message).to.equal('Credential manager operation failed')
      expect(reportedError.cause).to.equal(undefined)
      expect(reportedError.stack).to.not.include(providerError.message)
    })

    it('calls close on Sentry client after flush', async function () {
      delete process.env.CI
      process.env.NODE_ENV = 'development'
      delete process.env.IS_HEROKU_TEST_ENV
      delete process.env.DISABLE_TELEMETRY

      const closeStub = stub().resolves()
      stub(credentialSentrySdk, 'getClient').returns({close: closeStub} as unknown as NonNullable<ReturnType<typeof credentialSentrySdk.getClient>>)
      stub(credentialSentrySdk, 'init')
      stub(credentialSentrySdk, 'captureException')
      stub(credentialSentrySdk, 'flush').resolves(true)

      const err = new Error('Test error')
      await reportCredentialStoreError(err, {
        credentialStore: CredentialStore.MacOSKeychain,
        operation: 'saveAuth',
      })

      expect(closeStub.calledOnce).to.equal(true)
    })

    it('can report multiple errors in sequence', async function () {
      delete process.env.CI
      process.env.NODE_ENV = 'development'
      delete process.env.IS_HEROKU_TEST_ENV
      delete process.env.DISABLE_TELEMETRY

      const closeStub = stub().resolves()
      stub(credentialSentrySdk, 'getClient').returns({close: closeStub} as unknown as NonNullable<ReturnType<typeof credentialSentrySdk.getClient>>)
      stub(credentialSentrySdk, 'init')
      const captureStub = stub(credentialSentrySdk, 'captureException')
      stub(credentialSentrySdk, 'flush').resolves(true)

      const err1 = new Error('First error')
      await reportCredentialStoreError(err1, {
        credentialStore: CredentialStore.MacOSKeychain,
        operation: 'getAuth',
      })

      const err2 = new Error('Second error')
      await reportCredentialStoreError(err2, {
        credentialStore: CredentialStore.MacOSKeychain,
        operation: 'saveAuth',
      })

      // Both errors should be captured
      expect(captureStub.calledTwice).to.equal(true)
      expect(captureStub.firstCall.args[0]).to.be.instanceOf(Error)
      expect(captureStub.secondCall.args[0]).to.be.instanceOf(Error)
      expect(captureStub.firstCall.args[0]).to.not.equal(err1)
      expect(captureStub.secondCall.args[0]).to.not.equal(err2)

      // Close should be called for each error
      expect(closeStub.calledTwice).to.equal(true)
    })
  })

  describe('sanitizeCredentialErrorEvent', function () {
    it('removes opaque provider values from linked errors and event metadata', function () {
      const event = {
        breadcrumbs: [{message: 'opaque-token'}],
        contexts: {provider: {account: 'opaque-account'}},
        exception: {
          values: [{
            mechanism: {data: {service: 'opaque-service'}, type: 'provider'},
            stacktrace: {frames: [{filename: 'opaque-account'}]},
            type: 'ProviderError',
            value: 'opaque-account opaque-service opaque-token',
          }],
        },
        extra: {providerError: 'opaque-token'},
        tags: {
          component: 'heroku-cli-command',
          credential_operation: 'getAuth',
          credential_store: CredentialStore.MacOSKeychain,
          provider_account: 'opaque-account',
        },
        type: undefined,
      }

      const sanitized = sanitizeCredentialErrorEvent(event)
      const serialized = JSON.stringify(sanitized)

      expect(serialized).to.not.include('opaque-account')
      expect(serialized).to.not.include('opaque-service')
      expect(serialized).to.not.include('opaque-token')
      expect(sanitized.exception?.values).to.deep.equal([{
        type: 'CredentialManagerError',
        value: 'Credential manager operation failed',
      }])
      expect(sanitized.tags).to.deep.equal({
        component: 'heroku-cli-command',
        credential_operation: 'getAuth',
        credential_store: CredentialStore.MacOSKeychain,
      })
    })
  })
})
