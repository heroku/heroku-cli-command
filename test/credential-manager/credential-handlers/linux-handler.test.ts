import type {Duplex} from 'node:stream'

import {Message, MessageBus} from '@jellybrick/dbus-next'
import {expect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'
import childProcess from 'node:child_process'
import {EventEmitter} from 'node:events'
import sinon from 'sinon'

import {LinuxHandler} from '../../../src/credential-manager-core/credential-handlers/linux-handler.js'

use(chaiAsPromised)

describe('LinuxHandler', function () {
  let execFileSyncStub: sinon.SinonStub
  let spawnSyncStub: sinon.SinonStub
  let handler: LinuxHandler

  beforeEach(function () {
    execFileSyncStub = sinon.stub(childProcess, 'execFileSync')
    spawnSyncStub = sinon.stub(childProcess, 'spawnSync')
    handler = new LinuxHandler()
  })

  afterEach(function () {
    execFileSyncStub.restore()
    spawnSyncStub.restore()
  })

  describe('getAuth', function () {
    async function expectRejectedWith(promise: Promise<unknown>, message: string): Promise<void> {
      await expect(promise).to.be.rejectedWith(Error, message)
    }

    function setupSearch(reply: Message | null) {
      // dbus-next MessageBus uses EventEmitter; mirror that runtime interface in this test double.
      // eslint-disable-next-line unicorn/prefer-event-target
      const bus = new EventEmitter() as EventEmitter & Pick<MessageBus, 'call' | 'disconnect'>
      const callStub = sinon.stub().resolves(reply)
      const disconnectStub = sinon.stub()
      bus.call = callStub
      bus.disconnect = disconnectStub
      handler = new LinuxHandler(() => bus)
      return {bus, callStub, disconnectStub}
    }

    function searchReply(unlocked: string[], locked: string[] = []): Message {
      return {body: [unlocked, locked]} as unknown as Message
    }

    it('returns undefined when no matching items are unlocked or locked', async function () {
      const {callStub, disconnectStub} = setupSearch(searchReply([], []))
      const token = await handler.getAuth('test@example.com', 'heroku-cli')

      expect(token).to.be.undefined
      expect(callStub.calledOnce).to.be.true
      const message = callStub.firstCall.args[0] as Message
      expect(message.destination).to.equal('org.freedesktop.secrets')
      expect(message.path).to.equal('/org/freedesktop/secrets')
      expect(message.interface).to.equal('org.freedesktop.Secret.Service')
      expect(message.member).to.equal('SearchItems')
      expect(message.signature).to.equal('a{ss}')
      expect(message.body).to.deep.equal([{account: 'test@example.com', service: 'heroku-cli'}])
      expect(disconnectStub.calledOnce).to.be.true
      expect(execFileSyncStub.notCalled).to.be.true
    })

    it('looks up the token when an unlocked match exists', async function () {
      const {disconnectStub} = setupSearch(searchReply(['/org/freedesktop/secrets/item/1']))
      execFileSyncStub.returns('my-secret-token')

      const token = await handler.getAuth('test@example.com', 'heroku-cli')

      expect(execFileSyncStub.calledOnce).to.be.true
      expect(execFileSyncStub.args[0][0]).to.equal('secret-tool')
      expect(execFileSyncStub.args[0][1]).to.deep.equal(['lookup', 'service', 'heroku-cli', 'account', 'test@example.com'])
      expect(token).to.equal('my-secret-token')
      expect(disconnectStub.calledOnce).to.be.true
    })

    it('reports a retrieval error when the only match is locked', async function () {
      setupSearch(searchReply([], ['/org/freedesktop/secrets/collection/login/item_2']))
      execFileSyncStub.throws(new Error('The collection is locked'))

      await expectRejectedWith(
        handler.getAuth('test@example.com', 'heroku-cli'),
        'Failed to retrieve token from Linux keyring: The collection is locked',
      )
      expect(execFileSyncStub.calledOnce).to.be.true
      expect(execFileSyncStub.args[0][1]).to.deep.equal(['lookup', 'service', 'heroku-cli', 'account', 'test@example.com'])
    })

    it('throws a wrapped error when Secret Service search fails', async function () {
      const {bus, callStub, disconnectStub} = setupSearch(null)
      callStub.rejects(new Error('Permission denied'))

      await expectRejectedWith(
        handler.getAuth('test@example.com', 'heroku-cli'),
        'Failed to search Linux keyring: Permission denied',
      )
      expect(disconnectStub.calledOnce).to.be.true
      expect(bus.listenerCount('error')).to.equal(0)
      expect(execFileSyncStub.notCalled).to.be.true
    })

    it('throws a wrapped error when SearchItems returns a malformed reply', async function () {
      const {bus, callStub, disconnectStub} = setupSearch({body: [['not-an-object-path'], []]} as unknown as Message)

      await expectRejectedWith(
        handler.getAuth('test@example.com', 'heroku-cli'),
        'Failed to search Linux keyring: Secret Service SearchItems returned invalid item paths',
      )
      expect(callStub.calledOnce).to.be.true
      expect(disconnectStub.calledOnce).to.be.true
      expect(bus.listenerCount('error')).to.equal(0)
      expect(execFileSyncStub.notCalled).to.be.true
    })

    it('throws a wrapped error when SearchItems times out', async function () {
      const clock = sinon.useFakeTimers()
      const {bus, callStub, disconnectStub} = setupSearch(null)
      callStub.returns(new Promise(() => {}))
      const search = handler.getAuth('test@example.com', 'heroku-cli')
      const rejection = expectRejectedWith(search, 'Failed to search Linux keyring: Secret Service SearchItems timed out')

      try {
        await clock.tickAsync(5000)
        await rejection
        expect(disconnectStub.calledOnce).to.be.true
        expect(bus.listenerCount('error')).to.equal(0)
        expect(execFileSyncStub.notCalled).to.be.true
      } finally {
        clock.restore()
      }
    })

    it('handles a late D-Bus error after SearchItems times out until the socket closes', async function () {
      const clock = sinon.useFakeTimers()
      // dbus-next uses EventEmitter at runtime; mimic MessageBus/DBusConnection event semantics.
      // eslint-disable-next-line unicorn/prefer-event-target
      const bus = new EventEmitter() as EventEmitter & Pick<MessageBus, 'call' | 'disconnect'> & {
        _connection: EventEmitter & {stream?: Duplex}
      }
      // eslint-disable-next-line unicorn/prefer-event-target
      const stream = new EventEmitter() as EventEmitter & {destroy: () => void}
      // eslint-disable-next-line unicorn/prefer-event-target
      const connection = new EventEmitter() as EventEmitter & {stream?: Duplex}
      const callStub = sinon.stub().returns(new Promise(() => {}))
      const disconnectStub = sinon.stub()
      const destroyStub = sinon.stub()
      stream.destroy = destroyStub
      connection.stream = stream as unknown as Duplex
      bus.call = callStub
      bus.disconnect = disconnectStub
      bus._connection = connection
      // dbus-next forwards connection errors to MessageBus errors.
      connection.on('error', error => bus.emit('error', error))
      const initialConnectionErrorListeners = connection.listenerCount('error')
      handler = new LinuxHandler(() => bus)

      const search = handler.getAuth('test@example.com', 'heroku-cli')
      const rejection = expectRejectedWith(search, 'Failed to search Linux keyring: Secret Service SearchItems timed out')

      try {
        await clock.tickAsync(5000)
        await rejection

        expect(disconnectStub.calledOnce).to.be.true
        expect(destroyStub.calledOnce).to.be.true
        expect(bus.listenerCount('error')).to.equal(1)
        expect(() => connection.emit('error', new Error('late D-Bus connection error'))).to.not.throw()

        stream.emit('close')

        expect(bus.listenerCount('error')).to.equal(0)
        expect(connection.listenerCount('error')).to.equal(initialConnectionErrorListeners)
        expect(stream.listenerCount('close')).to.equal(0)
        expect(clock.countTimers()).to.equal(0)
      } finally {
        clock.restore()
      }
    })

    it('throws a wrapped error when the D-Bus connection emits an error', async function () {
      const {bus, callStub, disconnectStub} = setupSearch(null)
      callStub.returns(new Promise(() => {}))
      const search = handler.getAuth('test@example.com', 'heroku-cli')
      const rejection = expectRejectedWith(search, 'Failed to search Linux keyring: D-Bus connection closed')
      bus.emit('error', new Error('D-Bus connection closed'))

      await rejection

      expect(disconnectStub.calledOnce).to.be.true
      expect(bus.listenerCount('error')).to.equal(0)
      expect(execFileSyncStub.notCalled).to.be.true
    })

    it('throws a wrapped error when token retrieval fails after a match', async function () {
      setupSearch(searchReply(['/org/freedesktop/secrets/item/1']))
      const retrievalError = Object.assign(new Error('Command failed: secret-tool lookup service heroku-cli account test@example.com'), {
        status: 1,
        stderr: '',
      })
      execFileSyncStub.throws(retrievalError)

      await expectRejectedWith(
        handler.getAuth('test@example.com', 'heroku-cli'),
        'Failed to retrieve token from Linux keyring',
      )
      expect(execFileSyncStub.calledOnce).to.be.true
    })

    it('scrubs account names containing spaces from command errors', async function () {
      setupSearch(searchReply(['/org/freedesktop/secrets/item/1']))
      execFileSyncStub.throws(new Error('Command failed: secret-tool lookup service heroku-cli account Jane Doe Work'))

      try {
        await handler.getAuth('Jane Doe Work', 'heroku-cli')
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
        expect((error as Error).message).to.include('[SCRUBBED]')
        expect((error as Error).message).to.not.include('Jane Doe Work')
      }
    })

    it('rejects when the token retrieval returns an empty token after a match', async function () {
      setupSearch(searchReply(['/org/freedesktop/secrets/item/1']))
      execFileSyncStub.returns('  \n')

      await expectRejectedWith(
        handler.getAuth('test@example.com', 'heroku-cli'),
        'Failed to retrieve token from Linux keyring: Token not found',
      )
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
    it('should call spawnSync with the correct arguments to remove the token', function () {
      spawnSyncStub.returns({
        error: undefined,
        status: 0,
        stderr: '',
      })
      handler.removeAuth('test@example.com', 'heroku-cli')
      expect(spawnSyncStub.calledOnce).to.be.true
      expect(spawnSyncStub.args[0][0]).to.equal('secret-tool')
      expect(spawnSyncStub.args[0][1]).to.deep.equal(['clear', 'service', 'heroku-cli', 'account', 'test@example.com'])
    })

    it('should throw an error when removal fails', function () {
      spawnSyncStub.returns({
        error: undefined,
        status: 1,
        stderr: 'Permission denied',
      })
      expect(() => handler.removeAuth('test@example.com', 'heroku-cli')).to.throw('Failed to remove token from Linux keyring: Permission denied')
    })

    it('should return when no matching credential exists', function () {
      spawnSyncStub.returns({
        error: undefined,
        status: 1,
        stderr: 'No matching credentials\n',
      })
      expect(() => handler.removeAuth('missing@example.com', 'heroku-cli')).to.not.throw()
    })

    it('should scrub sensitive data from error messages', function () {
      spawnSyncStub.returns({
        error: undefined,
        status: 1,
        stderr: 'secret-tool clear service "heroku-cli" account "user@example.com" failed',
      })

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

    it('should return when secret-tool exits 1 with empty stderr', function () {
      spawnSyncStub.returns({
        error: undefined,
        status: 1,
        stderr: '',
      })
      expect(() => handler.removeAuth('missing@example.com', 'heroku-cli')).to.not.throw()
    })

    it('should return when secret-tool exits 1 with whitespace-only stderr', function () {
      spawnSyncStub.returns({
        error: undefined,
        status: 1,
        stderr: '  \n',
      })
      expect(() => handler.removeAuth('missing@example.com', 'heroku-cli')).to.not.throw()
    })

    it('should pass LC_ALL=C in the environment', function () {
      spawnSyncStub.returns({
        error: undefined,
        status: 0,
        stderr: '',
      })
      handler.removeAuth('test@example.com', 'heroku-cli')
      const options = spawnSyncStub.args[0][2]
      expect(options.env.LC_ALL).to.equal('C')
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
