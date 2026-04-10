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
      execSyncStub.returns('')
      expect(() => handler.getAuth('test@example.com', 'heroku-cli')).to.throw('Failed to retrieve token from Windows Credential Manager: Token not found')
    })

    it('should throw an error when retrieval fails', function () {
      execSyncStub.throws(new Error('Permission denied'))
      expect(() => handler.getAuth('test@example.com', 'heroku-cli')).to.throw('Failed to retrieve token from Windows Credential Manager: Permission denied')
    })

    it('should scrub sensitive data from error messages', function () {
      const err = new Error('Command failed: $vault.Retrieve("heroku-cli", "test@example.com")')
      execSyncStub.throws(err)

      try {
        handler.getAuth('test@example.com', 'heroku-cli')
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('Failed to retrieve token from Windows Credential Manager')
        expect((error as Error).message).to.include('[SCRUBBED]')
        expect((error as Error).message).to.not.include('test@example.com')
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
