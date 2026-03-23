import {expect} from 'chai'
import childProcess from 'node:child_process'
import sinon from 'sinon'

import {MacOSHandler} from '../../../src/credential-manager-core/credential-handlers/macos-handler.js'

describe('MacOSHandler', function () {
  let execSyncStub: sinon.SinonStub
  let handler: MacOSHandler

  beforeEach(function () {
    execSyncStub = sinon.stub(childProcess, 'execSync')
    handler = new MacOSHandler()
  })

  afterEach(function () {
    execSyncStub.restore()
  })

  describe('getAuth', function () {
    it('should call execSync with the correct arguments to retrieve the token', function () {
      execSyncStub.returns('my-secret-token')
      const token = handler.getAuth('test@example.com', 'heroku-cli')
      expect(execSyncStub.args[0][0]).to.contain('find-generic-password -a "test@example.com" -s "heroku-cli"')
      expect(token).to.equal('my-secret-token')
    })

    it('should throw an error when token is empty', function () {
      execSyncStub.returns('')
      expect(() => handler.getAuth('test@example.com', 'heroku-cli')).to.throw('Failed to retrieve token from macOS Keychain: Token not found')
    })

    it('should throw an error when retrieval fails', function () {
      execSyncStub.throws(new Error('Permission denied'))
      expect(() => handler.getAuth('test@example.com', 'heroku-cli')).to.throw('Failed to retrieve token from macOS Keychain: Permission denied')
    })

    it('should scrub sensitive data from error messages', function () {
      const err = new Error(
        'Command failed: security find-generic-password -a "test@example.com" -s "heroku-cli" -w',
      )
      execSyncStub.throws(err)

      try {
        handler.getAuth('test@example.com', 'heroku-cli')
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('Failed to retrieve token from macOS Keychain')
        expect((error as Error).message).to.include('[SCRUBBED]')
        expect((error as Error).message).to.not.include('test@example.com')
      }
    })
  })

  describe('listAccounts', function () {
    it('should call execSync with the correct arguments to list accounts', function () {
      execSyncStub.returns('')
      handler.listAccounts('heroku-cli')

      expect(execSyncStub.args[0][0]).to.equal('security dump-keychain')
    })

    it('should return an array of accounts when multiple credentials are found', function () {
      const mockOutput = `
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="heroku-cli"
    "acct"<blob>="user1@example.com"
    "svce"<blob>="heroku-cli"
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="heroku-cli"
    "acct"<blob>="user2@example.com"
    "svce"<blob>="heroku-cli"
`
      execSyncStub.returns(mockOutput)
      const accounts = handler.listAccounts('heroku-cli')

      expect(accounts).to.deep.equal(['user1@example.com', 'user2@example.com'])
    })

    it('should filter by service name when multiple services exist', function () {
      const mockOutput = `
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="test@example.com"
    "svce"<blob>="heroku-cli"
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="wrong@example.com"
    "svce"<blob>="other-service"
`
      execSyncStub.returns(mockOutput)
      const accounts = handler.listAccounts('heroku-cli')

      expect(accounts).to.deep.equal(['test@example.com'])
    })

    it('should only process generic password entries', function () {
      const mockOutput = `
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "cer"
attributes:
    "acct"<blob>="test1@example.com"
    "svce"<blob>=""
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="test2@example.com"
    "svce"<blob>="heroku-cli"
`
      execSyncStub.returns(mockOutput)
      const accounts = handler.listAccounts('heroku-cli')

      expect(accounts).to.deep.equal(['test2@example.com'])
    })

    it('should return a single account when only one credential is found', function () {
      const mockOutput = `
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="heroku-cli"
    "acct"<blob>="test@example.com"
    "svce"<blob>="heroku-cli"
`
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
      expect(() => handler.listAccounts('heroku-cli')).to.throw('Failed to list accounts in macOS Keychain: Permission denied')
    })
  })

  describe('removeAuth', function () {
    it('should call execSync with the correct arguments to remove the token', function () {
      execSyncStub.returns('')
      handler.removeAuth('test@example.com', 'heroku-cli')
      expect(execSyncStub.args[0][0]).to.contain('delete-generic-password -a "test@example.com" -s "heroku-cli"')
    })

    it('should throw an error when removal fails', function () {
      execSyncStub.throws(new Error('Permission denied'))
      expect(() => handler.removeAuth('test@example.com', 'heroku-cli')).to.throw('Failed to remove token from macOS Keychain: Permission denied')
    })

    it('should scrub sensitive data from error messages', function () {
      const err = new Error(
        'Command failed: security delete-generic-password -a "user@example.com" -s "heroku-cli"',
      )
      execSyncStub.throws(err)

      try {
        handler.removeAuth('user@example.com', 'heroku-cli')
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('Failed to remove token from macOS Keychain')
        expect((error as Error).message).to.include('[SCRUBBED]')
        expect((error as Error).message).to.not.include('user@example.com')
      }
    })
  })

  describe('saveAuth', function () {
    it('should call execSync with the correct arguments to save/update the token', function () {
      execSyncStub.returns('')
      const authMock = {
        account: 'test@example.com',
        service: 'heroku-cli',
        token: 'mytoken',
      }
      handler.saveAuth(authMock)
      expect(execSyncStub.args[0][0]).to.contain('add-generic-password -U -a "test@example.com" -s "heroku-cli" -w "mytoken"')
    })

    it('should throw an error when add command fails', function () {
      execSyncStub.throws(new Error('Permission denied'))

      const authMock = {
        account: 'test@example.com',
        service: 'heroku-cli',
        token: 'mytoken',
      }

      expect(() => handler.saveAuth(authMock)).to.throw('Failed to store token in macOS Keychain: Permission denied')
    })

    it('should scrub sensitive data from error messages', function () {
      const authMock = {
        account: 'test@example.com',
        service: 'heroku-cli',
        token: 'mytoken',
      }

      const err = new Error(
        `Command failed: security add-generic-password -U -a "${authMock.account}" -s "${authMock.service}" -w "${authMock.token}"`,
      )
      execSyncStub.throws(err)

      try {
        handler.saveAuth(authMock)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('Failed to store token in macOS Keychain')
        expect((error as Error).message).to.include('[SCRUBBED]')
        expect((error as Error).message).to.not.include('test@example.com')
        expect((error as Error).message).to.not.include('mytoken')
      }
    })
  })
})
