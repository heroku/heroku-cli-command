import {expect} from 'chai'
import childProcess from 'node:child_process'
import sinon from 'sinon'

import {WindowsHandler} from '../../../src/credential-manager-core/credential-handlers/windows-handler.js'

describe('WindowsHandler', function () {
  let execSyncStub: sinon.SinonStub
  let handler: WindowsHandler

  beforeEach(function () {
    execSyncStub = sinon.stub(childProcess, 'execSync')
    handler = new WindowsHandler()
  })

  afterEach(function () {
    execSyncStub.restore()
  })

  describe('getAuth', function () {
    it('should call execSync with the correct arguments to retrieve the token for the specified service and account', function () {
      execSyncStub.returns('my-secret-token')
      const token = handler.getAuth('test@example.com', 'heroku-cli')
      expect(execSyncStub.args[0][0]).to.contain('Retrieve("heroku-cli", "test@example.com")')
      expect(token).to.equal('my-secret-token')
    })

    it('should throw an error when token is empty', function () {
      execSyncStub.returns(' \n ')
      expect(() => handler.getAuth('test@example.com', 'heroku-cli'))
        .to.throw('Failed to retrieve credential: Token not found')
    })

    it('should throw when the credential is missing with the dedicated exit code', function () {
      const err = Object.assign(new Error('Command failed: private runtime detail'), {
        status: 44,
        stderr: Buffer.from('private stderr detail'),
      })
      execSyncStub.throws(err)

      expect(() => handler.getAuth('missing@example.com', 'heroku-cli')).to.throw('No credentials found')
      expect(execSyncStub.args[0][0]).to.contain('$_.Exception.HResult -eq -2147023728')
      expect(execSyncStub.args[0][0]).to.contain('exit 44')
    })
  })

  describe('getAuthIfAvailable', function () {
    it('should return the token when the credential exists', function () {
      execSyncStub.returns('my-secret-token')

      expect(handler.getAuthIfAvailable('test@example.com', 'heroku-cli')).to.equal('my-secret-token')
    })

    it('should return undefined only for the dedicated missing-credential exit code', function () {
      const err = Object.assign(new Error('Command failed'), {status: 44})
      execSyncStub.throws(err)

      expect(handler.getAuthIfAvailable('missing@example.com', 'heroku-cli')).to.be.undefined
    })

    it('should retain the legacy prefix for sanitized internal failures', function () {
      execSyncStub.throws(new Error('Access denied: private runtime detail account-1234 heroku-cli'))

      let thrown: unknown
      try {
        handler.getAuthIfAvailable('account-1234', 'heroku-cli')
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(Error)
      const {message} = thrown as Error
      expect(message).to.equal('Failed to retrieve credential: Access denied')
      expect(message).to.not.include('private')
      expect(message).to.not.include('account-1234')
      expect(message).to.not.include('heroku-cli')
    })
  })

  describe('getAuth diagnostics', function () {
    it('should throw an error when retrieval fails', function () {
      execSyncStub.throws(new Error('Access denied'))
      expect(() => handler.getAuth('test@example.com', 'heroku-cli'))
        .to.throw('Failed to retrieve credential: Access denied')
    })

    it('should omit untrusted details from unrelated errors containing missing-credential phrases', function () {
      const err = new Error('Unrelated PowerShell failure: element not found; diagnostic code 0x80070490')
      execSyncStub.throws(err)

      let thrown: unknown
      try {
        handler.getAuth('test@example.com', 'heroku-cli')
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(Error)
      expect((thrown as Error).message).to.equal('Failed to retrieve credential')
      expect((thrown as Error).message).to.not.match(/:$/)
    })

    it('should retain only safe diagnostics from retrieval failures reported on stderr', function () {
      const err = Object.assign(new Error('Command failed: Retrieve("heroku-cli", "test@example.com")'), {
        stderr: Buffer.from('Access denied retrieving Retrieve("heroku-cli", "test@example.com")'),
      })
      execSyncStub.throws(err)

      let thrown: unknown
      try {
        handler.getAuth('test@example.com', 'heroku-cli')
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(Error)
      const {message} = thrown as Error
      expect(message).to.equal('Failed to retrieve credential: Access denied')
      expect(message).to.include('Access denied')
      expect(message).to.not.include('[SCRUBBED]')
      expect(message).to.not.include('test@example.com')
      expect(message).to.not.include('heroku-cli')
    })

    it('should redact unquoted account and service values from the combined error message', function () {
      const account = 'opaque-account-7f3a'
      const service = 'opaque-service-9c2b'
      const err = Object.assign(new Error(`Command failed for ${account}`), {
        stderr: Buffer.from(`Credential lookup failed for ${account} on ${service}: token=untrusted-secret-5d11; Access denied`),
      })
      execSyncStub.throws(err)

      let thrown: unknown
      try {
        handler.getAuth(account, service)
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(Error)
      const {message} = thrown as Error
      expect(message).to.equal('Failed to retrieve credential: Access denied')
      expect(message).to.not.include('[SCRUBBED]')
      expect(message).to.not.include(account)
      expect(message).to.not.include(service)
      expect(message).to.not.include('untrusted-secret-5d11')
    })

    it('should preserve useful error text when account and service are empty', function () {
      execSyncStub.throws(new Error('Access denied'))

      expect(() => handler.getAuth('', '')).to.throw('Failed to retrieve credential: Access denied')
    })

    it('should retain the safe prefix for ordinary failures', function () {
      execSyncStub.throws(new Error('Access denied'))

      let thrown: unknown
      try {
        handler.getAuth('account-1234', 'Windows')
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(Error)
      const {message} = thrown as Error
      expect(message).to.equal('Failed to retrieve credential: Access denied')
      expect(message).to.not.include('Windows')
    })

    it('should use a meaningful fallback for short identifiers without substring collisions', function () {
      execSyncStub.throws(new Error('Access denied'))

      let thrown: unknown
      try {
        handler.getAuth('e', 'heroku-cli')
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(Error)
      const {message} = thrown as Error
      expect(message).to.not.match(/:$/)
      expect(message).to.not.match(/(^|[^A-Za-z0-9_])e($|[^A-Za-z0-9_])/i)
      expect(message).to.match(/[a-z]/i)
    })

    it('should not empty the fallback when one-character identifiers occur inside ordinary words', function () {
      execSyncStub.throws(new Error('Access denied'))

      let thrown: unknown
      try {
        handler.getAuth('o', 't')
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(Error)
      const {message} = thrown as Error
      expect(message).to.not.match(/:$/)
      expect(message).to.match(/[a-z]/i)
      expect(message).to.not.match(/(^|[^A-Za-z0-9_])o($|[^A-Za-z0-9_])/i)
      expect(message).to.not.match(/(^|[^A-Za-z0-9_])t($|[^A-Za-z0-9_])/i)
    })

    it('should check the composed fixed prefix for exact runtime identifiers', function () {
      execSyncStub.throws(new Error('Access denied'))

      let thrown: unknown
      try {
        handler.getAuth('account-1234', 'credential')
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(Error)
      const {message} = thrown as Error
      expect(message).to.equal('Authentication lookup failed')
      expect(message).to.not.equal('')
      expect(message).to.not.include('credential')
    })

    it('should omit the marker when the account value collides with the redaction marker', function () {
      const account = '[SCRUBBED]'
      execSyncStub.throws(new Error(`Credential lookup failed for ${account}: Access denied`))

      let thrown: unknown
      try {
        handler.getAuth(account, 'heroku-cli')
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(Error)
      const {message} = thrown as Error
      expect(message).to.equal('Failed to retrieve credential: Access denied')
      expect(message).to.not.include(account)
    })

    it('should not treat an arbitrary scrub marker as evidence of redaction', function () {
      const secret = 'customer@example.com'
      const token = 'untrusted-secret-72fd'
      const err = Object.assign(new Error('PowerShell command failed'), {
        stderr: Buffer.from(`[SCRUBBED] ${secret} token=${token}`),
      })
      execSyncStub.throws(err)

      let thrown: unknown
      try {
        handler.getAuth(secret, 'heroku-cli')
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(Error)
      const {message} = thrown as Error
      expect(message).to.equal('Failed to retrieve credential')
      expect(message).to.not.match(/:$/)
      expect(message).to.not.include(secret)
      expect(message).to.not.include(token)
      expect(message).to.not.include('[SCRUBBED]')
    })

    it('should check identifiers case-insensitively when composing fallback diagnostics', function () {
      execSyncStub.throws(new Error('Access denied'))

      let thrown: unknown
      try {
        handler.getAuth('account-1234', 'CREDENTIAL')
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(Error)
      const {message} = thrown as Error
      expect(message).to.equal('Authentication lookup failed')
      expect(message.toLowerCase()).to.not.include('credential')
      expect(message).to.not.match(/:$/)
    })

    it('should redact account and service identifiers case-insensitively', function () {
      const account = 'opaque-account-7f3a'
      const service = 'opaque-service-9c2b'
      execSyncStub.throws(new Error(`ACCESS DENIED for ${account.toUpperCase()} on ${service.toUpperCase()}`))

      let thrown: unknown
      try {
        handler.getAuth(account, service)
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(Error)
      const {message} = thrown as Error
      expect(message).to.equal('Failed to retrieve credential: Access denied')
      expect(message.toLowerCase()).to.not.include(account.toLowerCase())
      expect(message.toLowerCase()).to.not.include(service.toLowerCase())
      expect(message).to.not.match(/:$/)
    })

    it('should scrub sensitive data from error messages', function () {
      const err = new Error('Command failed: $vault.Retrieve("heroku-cli", "test@example.com")')
      execSyncStub.throws(err)

      try {
        handler.getAuth('test@example.com', 'heroku-cli')
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.equal('Failed to retrieve credential')
        expect((error as Error).message).to.not.match(/:$/)
        expect((error as Error).message).to.not.include('[SCRUBBED]')
        expect((error as Error).message).to.not.include('test@example.com')
        expect((error as Error).message).to.not.include('heroku-cli')
      }
    })
  })

  describe('listAccounts', function () {
    it('should call execSync with the correct arguments to list accounts', function () {
      execSyncStub.returns('')
      handler.listAccounts('heroku-cli')

      expect(execSyncStub.args[0][0]).to.contain('FindAllByResource("heroku-cli")')
      expect(execSyncStub.args[0][0]).to.contain('ForEach-Object { $_.UserName }')
    })

    it('should return an array of accounts when multiple credentials are found', function () {
      const mockOutput = `
user1@example.com
user2@example.com
`
      execSyncStub.returns(mockOutput)
      const accounts = handler.listAccounts('heroku-cli')

      expect(accounts).to.deep.equal(['user1@example.com', 'user2@example.com'])
    })

    it('should return a single account when only one credential is found', function () {
      const mockOutput = 'test@example.com'
      execSyncStub.returns(mockOutput)
      const accounts = handler.listAccounts('heroku-cli')

      expect(accounts).to.deep.equal(['test@example.com'])
    })

    it('should return an empty array when no credentials are found', function () {
      execSyncStub.returns('')
      const accounts = handler.listAccounts('heroku-cli')

      expect(accounts).to.deep.equal([])
    })

    it('should throw an error when the search command fails', function () {
      execSyncStub.throws(new Error('Permission denied'))
      expect(() => handler.listAccounts('heroku-cli')).to.throw('Failed to list accounts in Windows Credential Manager: Permission denied')
    })
  })

  describe('removeAuth', function () {
    it('should call execSync with the correct arguments to remove the token for the specified service and account', function () {
      execSyncStub.returns('')
      handler.removeAuth('test@example.com', 'heroku-cli')
      expect(execSyncStub.args[0][0]).to.contain('Retrieve("heroku-cli", "test@example.com")')
      expect(execSyncStub.args[0][0]).to.contain('vault.Remove')
    })

    it('should throw an error when removal fails', function () {
      execSyncStub.throws(new Error('Permission denied'))
      expect(() => handler.removeAuth('test@example.com', 'heroku-cli')).to.throw('Failed to remove token from Windows Credential Manager: Permission denied')
    })

    it('should return when the credential does not exist', function () {
      execSyncStub.throws(new Error('Element not found'))
      expect(() => handler.removeAuth('missing@example.com', 'heroku-cli')).to.not.throw()
    })

    it('should scrub sensitive data from error messages', function () {
      const err = new Error('Command failed: $vault.Retrieve("heroku-cli", "test@example.com")')
      execSyncStub.throws(err)

      try {
        handler.removeAuth('test@example.com', 'heroku-cli')
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('Failed to remove token from Windows Credential Manager')
        expect((error as Error).message).to.include('[SCRUBBED]')
        expect((error as Error).message).to.not.include('test@example.com')
      }
    })
  })

  describe('saveAuth', function () {
    it('should call execSync with the correct arguments to save the token for the specified service and account', function () {
      execSyncStub.returns('')
      const authMock = {
        account: 'test@example.com',
        service: 'heroku-cli',
        token: 'mytoken',
      }
      handler.saveAuth(authMock)
      expect(execSyncStub.args[0][0]).to.contain('Retrieve("heroku-cli", "test@example.com")')
      expect(execSyncStub.args[0][0]).to.contain('vault.Remove')
      expect(execSyncStub.args[1][0]).to.contain('New-Object Windows.Security.Credentials.PasswordCredential("heroku-cli", "test@example.com", "mytoken")')
      expect(execSyncStub.args[1][0]).to.contain('vault.Add')
    })

    it('should throw an error when add command fails', function () {
      execSyncStub.onFirstCall().returns('')
      execSyncStub.onSecondCall().throws(new Error('Permission denied'))

      const authMock = {
        account: 'test@example.com',
        service: 'heroku-cli',
        token: 'mytoken',
      }

      expect(() => handler.saveAuth(authMock)).to.throw('Failed to store token in Windows Credential Manager: Permission denied')
    })

    it('should scrub sensitive data from error messages', function () {
      execSyncStub.onFirstCall().returns('')

      const err = new Error('Command failed: New-Object Windows.Security.Credentials.PasswordCredential("heroku-cli", "test@example.com", "mytoken")')
      execSyncStub.onSecondCall().throws(err)

      const authMock = {
        account: 'test@example.com',
        service: 'heroku-cli',
        token: 'mytoken',
      }

      try {
        handler.saveAuth(authMock)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('Failed to store token in Windows Credential Manager')
        expect((error as Error).message).to.include('[SCRUBBED]')
        expect((error as Error).message).to.not.include('test@example.com')
        expect((error as Error).message).to.not.include('mytoken')
      }
    })

    it('should continue to add credential when remove fails because item does not exist', function () {
      execSyncStub.onFirstCall().throws(new Error('Element not found'))
      execSyncStub.onSecondCall().returns('')
      const authMock = {
        account: 'test@example.com',
        service: 'heroku-cli',
        token: 'mytoken',
      }
      handler.saveAuth(authMock)
      expect(execSyncStub.calledTwice).to.be.true
      expect(execSyncStub.args[1][0]).to.contain('vault.Add')
    })
  })
})
