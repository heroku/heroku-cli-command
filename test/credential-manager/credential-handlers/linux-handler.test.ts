import {expect} from 'chai'
import childProcess from 'node:child_process'
import sinon from 'sinon'

import {LinuxHandler} from '../../../src/credential-manager-core/credential-handlers/linux-handler.js'

describe('LinuxHandler', function () {
  let execSyncStub: sinon.SinonStub
  let spawnSyncStub: sinon.SinonStub
  let handler: LinuxHandler

  beforeEach(function () {
    execSyncStub = sinon.stub(childProcess, 'execSync')
    spawnSyncStub = sinon.stub(childProcess, 'spawnSync')
    handler = new LinuxHandler()
  })

  afterEach(function () {
    execSyncStub.restore()
    spawnSyncStub.restore()
  })

  describe('getAuth', function () {
    it('should call execSync with the correct arguments to retrieve the token', function () {
      execSyncStub.returns('my-secret-token')
      const token = handler.getAuth('test@example.com', 'heroku-cli')
      expect(execSyncStub.args[0][0]).to.contain('secret-tool lookup service "heroku-cli" account "test@example.com"')
      expect(token).to.equal('my-secret-token')
    })

    it('should throw an error when token is empty', function () {
      execSyncStub.returns('')
      expect(() => handler.getAuth('test@example.com', 'heroku-cli')).to.throw('Failed to retrieve token from Linux keyring: Token not found')
    })

    it('should throw an error when retrieval fails', function () {
      execSyncStub.throws(new Error('Permission denied'))
      expect(() => handler.getAuth('test@example.com', 'heroku-cli')).to.throw('Failed to retrieve token from Linux keyring: Permission denied')
    })

    it('should scrub sensitive data from error messages', function () {
      const err = new Error(
        'Command failed: secret-tool lookup service "heroku-cli" account "test@example.com"',
      )
      execSyncStub.throws(err)

      try {
        handler.getAuth('test@example.com', 'heroku-cli')
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('Failed to retrieve token from Linux keyring')
        expect((error as Error).message).to.include('[SCRUBBED]')
        expect((error as Error).message).to.not.include('test@example.com')
      }
    })
  })

  describe('listAccounts', function () {
    it('should call spawnSync with the correct arguments to list accounts', function () {
      spawnSyncStub.returns({
        error: undefined,
        status: 0,
        stderr: '',
      })
      handler.listAccounts('heroku-cli')
      expect(spawnSyncStub.calledOnce).to.be.true
      expect(spawnSyncStub.args[0][0]).to.equal('secret-tool')
      expect(spawnSyncStub.args[0][1]).to.deep.equal(['search', '--all', 'service', 'heroku-cli'])
    })

    it('should return an array of accounts when multiple credentials are found', function () {
      const mockStderr = `
attribute.account = user1@example.com
attribute.service = heroku-cli
attribute.account = user2@example.com
attribute.service = heroku-cli
`
      spawnSyncStub.returns({
        error: undefined,
        status: 0,
        stderr: mockStderr,
      })
      const accounts = handler.listAccounts('heroku-cli')

      expect(accounts).to.deep.equal(['user1@example.com', 'user2@example.com'])
    })

    it('should return a single account when only one credential is found', function () {
      const mockStderr = `
attribute.account = test@example.com
attribute.service = heroku-cli
`
      spawnSyncStub.returns({
        error: undefined,
        status: 0,
        stderr: mockStderr,
      })
      const accounts = handler.listAccounts('heroku-cli')

      expect(accounts).to.deep.equal(['test@example.com'])
    })

    it('should return an empty array when no credentials are found', function () {
      spawnSyncStub.returns({
        error: undefined,
        status: 0,
        stderr: '',
      })
      const accounts = handler.listAccounts('heroku-cli')

      expect(accounts).to.deep.equal([])
    })

    it('should throw an error when the search command fails', function () {
      spawnSyncStub.returns({
        error: undefined,
        status: 1,
        stderr: 'Permission denied',
      })
      expect(() => handler.listAccounts('heroku-cli')).to.throw('Failed to list accounts in Linux keyring: Permission denied')
    })

    it('should throw an error when spawnSync encounters a system error', function () {
      spawnSyncStub.returns({
        error: new Error('ENOENT: secret-tool command not found'),
        status: null,
        stderr: '',
      })
      expect(() => handler.listAccounts('heroku-cli')).to.throw('Failed to list accounts in Linux keyring: ENOENT: secret-tool command not found')
    })
  })

  describe('removeAuth', function () {
    it('should call execSync with the correct arguments to remove the token', function () {
      execSyncStub.returns('')
      handler.removeAuth('test@example.com', 'heroku-cli')
      expect(execSyncStub.args[0][0]).to.contain('secret-tool clear service "heroku-cli" account "test@example.com"')
    })

    it('should throw an error when removal fails', function () {
      execSyncStub.throws(new Error('Permission denied'))
      expect(() => handler.removeAuth('test@example.com', 'heroku-cli')).to.throw('Failed to remove token from Linux keyring: Permission denied')
    })

    it('should scrub sensitive data from error messages', function () {
      const err = new Error(
        'Command failed: secret-tool clear service "heroku-cli" account "user@example.com"',
      )
      execSyncStub.throws(err)

      try {
        handler.removeAuth('user@example.com', 'heroku-cli')
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('Failed to remove token from Linux keyring')
        expect((error as Error).message).to.include('[SCRUBBED]')
        expect((error as Error).message).to.not.include('user@example.com')
      }
    })
  })

  describe('saveAuth', function () {
    it('should call spawnSync with the correct arguments to save/update the token', function () {
      spawnSyncStub.returns({
        error: undefined,
        status: 0,
        stderr: '',
      })
      const authMock = {
        account: 'test@example.com',
        service: 'heroku-cli',
        token: 'mytoken',
      }
      handler.saveAuth(authMock)

      expect(spawnSyncStub.calledOnce).to.be.true
      expect(spawnSyncStub.args[0][0]).to.equal('secret-tool')
      expect(spawnSyncStub.args[0][1]).to.deep.equal([
        'store',
        '--label=Heroku CLI',
        'service',
        'heroku-cli',
        'account',
        'test@example.com',
      ])
      expect(spawnSyncStub.args[0][2].input).to.equal('mytoken')
    })

    it('should throw an error when save command fails', function () {
      const authMock = {
        account: 'test@example.com',
        service: 'heroku-cli',
        token: 'mytoken',
      }

      spawnSyncStub.returns({
        error: undefined,
        status: 1,
        stderr: 'error communicating with Secret Service',
      })
      expect(() => handler.saveAuth(authMock)).to.throw('Failed to store token in Linux keyring: error communicating with Secret Service')
    })

    it('should throw an error when spawnSync encounters a system error', function () {
      const authMock = {
        account: 'test@example.com',
        service: 'heroku-cli',
        token: 'mytoken',
      }

      spawnSyncStub.returns({
        error: new Error('ENOENT: secret-tool command not found'),
        status: null,
        stderr: '',
      })
      expect(() => handler.saveAuth(authMock)).to.throw('Failed to store token in Linux keyring: ENOENT: secret-tool command not found')
    })

    it('should use fallback error message when stderr is empty', function () {
      const authMock = {
        account: 'test@example.com',
        service: 'heroku-cli',
        token: 'mytoken',
      }

      spawnSyncStub.returns({
        error: undefined,
        status: 1,
        stderr: '', // Empty stderr triggers fallback
      })
      expect(() => handler.saveAuth(authMock)).to.throw('Failed to store token in Linux keyring: Unknown error')
    })

    it('should scrub sensitive data from error messages', function () {
      const authMock = {
        account: 'test@example.com',
        service: 'heroku-cli',
        token: 'mytoken',
      }

      spawnSyncStub.returns({
        error: undefined,
        status: 1,
        stderr: 'Command failed: secret-tool store service "heroku-cli" account "user@example.com"',
      })

      try {
        handler.saveAuth(authMock)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('Failed to store token in Linux keyring')
        expect((error as Error).message).to.include('[SCRUBBED]')
        expect((error as Error).message).to.not.include('user@example.com')
      }
    })
  })
})
