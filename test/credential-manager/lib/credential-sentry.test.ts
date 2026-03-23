import {expect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'

import {
  credentialSentrySdk,
  reportCredentialStoreError,
  shouldReportCredentialErrorsToSentry,
} from '../../../src/credential-manager-core/lib/credential-sentry.js'
import {CredentialStore} from '../../../src/credential-manager-core/lib/credential-storage-selector.js'

use(chaiAsPromised)

describe('credential-sentry', function () {
  afterEach(function () {
    sinon.restore()
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
      const captureStub = sinon.stub(credentialSentrySdk, 'captureException')
      const err = new Error('keychain failed')
      await reportCredentialStoreError(err, {
        credentialStore: CredentialStore.MacOSKeychain,
        operation: 'saveAuth',
      })
      expect(captureStub.called).to.equal(false)
    })

    it('does not capture when NODE_ENV is test', async function () {
      process.env.NODE_ENV = 'test'
      const captureStub = sinon.stub(credentialSentrySdk, 'captureException')
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

      sinon.stub(credentialSentrySdk, 'getClient').returns({} as NonNullable<ReturnType<typeof credentialSentrySdk.getClient>>)
      sinon.stub(credentialSentrySdk, 'init')
      const captureStub = sinon.stub(credentialSentrySdk, 'captureException')
      sinon.stub(credentialSentrySdk, 'flush').resolves(true)

      const err = new Error('Failed to retrieve token from macOS Keychain: scrubbed')
      await reportCredentialStoreError(err, {
        credentialStore: CredentialStore.MacOSKeychain,
        operation: 'getAuth',
      })

      expect(captureStub.calledOnce).to.equal(true)
      expect(captureStub.firstCall.args[0]).to.equal(err)
      expect(captureStub.firstCall.args[1]).to.deep.include({
        tags: {
          component: 'heroku-credential-manager',
          credential_operation: 'getAuth',
          credential_store: CredentialStore.MacOSKeychain,
        },
      })
    })
  })
})
