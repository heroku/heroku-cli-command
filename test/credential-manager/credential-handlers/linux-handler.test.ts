import type {SinonStub} from 'sinon'

import {Message} from '@jellybrick/dbus-next'
import {expect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'
import childProcess from 'node:child_process'
import {EventEmitter} from 'node:events'
import {existsSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {stub, useFakeTimers} from 'sinon'

import {createChildEnvironment, LinuxHandler} from '../../../src/credential-manager-core/credential-handlers/linux-handler.js'
import {searchKeyring} from '../../../src/credential-manager-core/credential-handlers/linux-keyring-search.mjs'

use(chaiAsPromised)

const runSubprocess = childProcess.spawnSync.bind(childProcess)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceHelperPath = resolve(projectRoot, 'src/credential-manager-core/credential-handlers/linux-keyring-search.mjs')
const builtHelperPath = resolve(projectRoot, 'lib/credential-manager-core/credential-handlers/linux-keyring-search.mjs')
const mockedDbusLoader = `data:text/javascript,${encodeURIComponent(`
  const mockModule = ${JSON.stringify(`
    import {EventEmitter} from 'node:events'
    export class Message { constructor() {} }
    export function sessionBus() {
      const bus = new EventEmitter()
      setInterval(() => {}, 60_000)
      return Object.assign(bus, {
        call() { return Promise.resolve({body: [[], []]}) },
        disconnect() { queueMicrotask(() => bus.emit('error', new Error('late D-Bus error'))) },
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
const TEST_CHILD_ENV = {
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/linux-keyring-test-bus',
  DBUS_STARTER_ADDRESS: 'unix:path=/tmp/linux-keyring-test-starter-bus',
  DBUS_STARTER_BUS_TYPE: 'session',
  DISPLAY: ':71',
  HOME: '/tmp/linux-keyring-test-home',
  LC_ALL: 'C',
  PATH: '/test/bin',
  XDG_RUNTIME_DIR: '/tmp/linux-keyring-test-runtime',
}

function withEnvironment(values: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

function expectMinimalChildEnvironment(env: NodeJS.ProcessEnv): void {
  const allowedKeys = new Set(Object.keys(TEST_CHILD_ENV))
  expect(Object.keys(env).every(key => allowedKeys.has(key))).to.be.true
  expect(env.PATH).to.be.a('string').and.not.empty
  expect(env.HOME).to.be.a('string').and.not.empty
  expect(env.LC_ALL).to.equal('C')
  expect(env).to.not.have.property('HEROKU_API_KEY')
  expect(env).to.not.have.property('AWS_SECRET_ACCESS_KEY')
}

function setupBus(reply: unknown) {
  // dbus-next MessageBus uses EventEmitter at runtime; mirror that runtime interface in this test double.
  // eslint-disable-next-line unicorn/prefer-event-target
  const bus = new EventEmitter() as EventEmitter & {call: (message: Message) => Promise<unknown>; disconnect: () => void}
  const callStub = stub().resolves(reply)
  const disconnectStub = stub()
  bus.call = callStub
  bus.disconnect = disconnectStub
  return {bus, callStub, disconnectStub}
}

describe('LinuxHandler', function () {
  let execFileSyncStub: SinonStub
  let spawnSyncStub: SinonStub
  let handler: LinuxHandler

  beforeEach(function () {
    execFileSyncStub = stub(childProcess, 'execFileSync')
    spawnSyncStub = stub(childProcess, 'spawnSync')
    handler = new LinuxHandler()
  })

  afterEach(function () {
    execFileSyncStub.restore()
    spawnSyncStub.restore()
  })

  describe('getAuth', function () {
    const account = 'test@example.com'
    const service = 'heroku-cli'

    it('returns synchronously and launches the helper with only JSON input', function () {
      execFileSyncStub.onFirstCall().returns('{"status":"match"}')
      execFileSyncStub.onSecondCall().returns('my-secret-token')

      let token: string | undefined
      withEnvironment({
        ...TEST_CHILD_ENV,
        AWS_SECRET_ACCESS_KEY: 'do-not-forward-this-cloud-secret',
        HEROKU_API_KEY: 'do-not-forward-this-heroku-secret',
        LANG: 'en_US.UTF-8',
      }, () => {
        token = handler.getAuth(account, service)
      })

      expect(token).to.equal('my-secret-token')
      expect(token).to.not.be.instanceOf(Promise)
      expect(execFileSyncStub.callCount).to.equal(2)
      const [nodePath, helperArgs, helperOptions] = execFileSyncStub.firstCall.args
      expect(nodePath).to.equal(process.execPath)
      expect(helperArgs).to.have.length(1)
      expect(helperArgs[0]).to.match(/linux-keyring-search\.mjs$/)
      expect(helperOptions.input).to.equal(JSON.stringify({account, service}))
      expect(helperOptions.stdio).to.deep.equal(['pipe', 'pipe', 'ignore'])
      expect(helperOptions.timeout).to.equal(5000)
      expect(helperOptions.maxBuffer).to.be.a('number').and.greaterThan(0)
      expect(helperOptions.killSignal).to.equal('SIGKILL')
      expect(helperOptions.shell).to.be.undefined
      expect(helperOptions.env).to.deep.equal(TEST_CHILD_ENV)
      expect(helperOptions.env.DBUS_SESSION_BUS_ADDRESS).to.equal(TEST_CHILD_ENV.DBUS_SESSION_BUS_ADDRESS)
      expect(helperOptions.env.DBUS_STARTER_ADDRESS).to.equal(TEST_CHILD_ENV.DBUS_STARTER_ADDRESS)
      expect(helperOptions.env.XDG_RUNTIME_DIR).to.equal(TEST_CHILD_ENV.XDG_RUNTIME_DIR)
      expect(helperOptions.env.HOME).to.equal(TEST_CHILD_ENV.HOME)
      expect(helperOptions.env.PATH).to.equal(TEST_CHILD_ENV.PATH)
      expectMinimalChildEnvironment(helperOptions.env)
      expect(execFileSyncStub.secondCall.args[0]).to.equal('secret-tool')
      expect(execFileSyncStub.secondCall.args[1]).to.deep.equal(['lookup', 'service', service, 'account', account])
      expect(execFileSyncStub.secondCall.args[2].env).to.equal(helperOptions.env)
      expectMinimalChildEnvironment(execFileSyncStub.secondCall.args[2].env)
    })

    it('returns the token from getAuthIfAvailable when the credential exists', function () {
      execFileSyncStub.onFirstCall().returns('{"status":"match"}')
      execFileSyncStub.onSecondCall().returns('my-secret-token')

      expect(handler.getAuthIfAvailable(account, service)).to.equal('my-secret-token')
      expect(execFileSyncStub.calledTwice).to.be.true
    })

    it('returns undefined from getAuthIfAvailable for exact no-match protocol without looking up a secret', function () {
      execFileSyncStub.returns('{"status":"no-match"}')

      expect(handler.getAuthIfAvailable(account, service)).to.be.undefined
      expect(execFileSyncStub.calledOnce).to.be.true
    })

    it('throws from getAuth when the keyring has no matching item', function () {
      execFileSyncStub.returns('{"status":"no-match"}')

      expect(() => handler.getAuth(account, service)).to.throw('No credentials found')
      expect(execFileSyncStub.calledOnce).to.be.true
    })

    it('rejects malformed, non-compact, duplicate-key, and extra-field helper output', function () {
      const invalidOutputs = [
        '',
        'null',
        '[]',
        '{}',
        '{"status":"unknown"}',
        '{"status":"match","extra":true}',
        '{"status":"match" }',
        '{"status":"match"} trailing junk',
        '{"status":"match","status":"no-match"}',
      ]

      for (const protocolOutput of invalidOutputs) {
        execFileSyncStub.resetBehavior()
        execFileSyncStub.resetHistory()
        execFileSyncStub.returns(protocolOutput)

        expect(() => handler.getAuth(account, service), JSON.stringify(protocolOutput))
          .to.throw('Failed to search Linux keyring')
        expect(execFileSyncStub.calledOnce).to.be.true
      }
    })

    it('fails closed with a fixed error when the helper fails or times out', function () {
      const nonzeroError = Object.assign(new Error(`helper failure leaked ${account} ${service}`), {
        status: 1,
        stderr: 'untrusted helper diagnostic',
      })
      const timeoutError = Object.assign(new Error(`helper timeout leaked ${account} ${service}`), {code: 'ETIMEDOUT'})
      execFileSyncStub.onFirstCall().throws(nonzeroError)
      execFileSyncStub.onSecondCall().throws(timeoutError)

      expect(() => handler.getAuth(account, service)).to.throw('Failed to search Linux keyring')
      expect(() => handler.getAuth(account, service)).to.throw('Failed to search Linux keyring')
      expect(execFileSyncStub.calledTwice).to.be.true
      expect(execFileSyncStub.firstCall.args[0]).to.equal(process.execPath)
    })

    it('does not invoke secret-tool when helper reports a locked match', function () {
      execFileSyncStub.returns('{"status":"locked-match"}')

      expect(() => handler.getAuth(account, service))
        .to.throw('Failed to retrieve token from Linux keyring: keyring is locked')
      expect(execFileSyncStub.calledOnce).to.be.true
    })

    it('fails closed with a fixed error when secret-tool lookup fails', function () {
      execFileSyncStub.onFirstCall().returns('{"status":"match"}')
      execFileSyncStub.onSecondCall().throws(new Error(`secret-tool leaked ${account} ${service}`))

      expect(() => handler.getAuth(account, service)).to.throw('Failed to retrieve token from Linux keyring')
      expect(execFileSyncStub.calledTwice).to.be.true
    })

    it('bounds and kills the synchronous secret-tool lookup', function () {
      execFileSyncStub.onFirstCall().returns('{"status":"match"}')
      execFileSyncStub.onSecondCall().returns('token')
      handler.getAuth(account, service)

      const lookupOptions = execFileSyncStub.secondCall.args[2]
      expect(lookupOptions.timeout).to.be.a('number').and.greaterThan(0)
      expect(lookupOptions.maxBuffer).to.be.a('number').and.greaterThan(0)
      expect(lookupOptions.killSignal).to.equal('SIGKILL')
      expect(lookupOptions.shell).to.be.undefined
    })

    it('fails closed on an empty secret-tool result', function () {
      execFileSyncStub.onFirstCall().returns('{"status":"match"}')
      execFileSyncStub.onSecondCall().returns('  \n')

      expect(() => handler.getAuth(account, service)).to.throw('Failed to retrieve token from Linux keyring')
    })
  })

  describe('Linux SearchItems helper subprocess protocol', function () {
    // A successful SearchItems subprocess requires an isolated D-Bus/Secret Service fixture. These
    // unit tests stay bus-independent and never connect to the invoking user's keyring. The built
    // helper mode runs after the package build; it is skipped when lib has not been generated.
    for (const [mode, helperPath] of [['source', sourceHelperPath], ['built lib', builtHelperPath]] as const) {
      it(`writes compact JSON status and handles late bus errors in ${mode} mode${mode === 'built lib' ? ' when built helper is present' : ''}`, function () {
        if (mode === 'built lib' && !existsSync(helperPath)) this.skip()

        const result = runSubprocess(process.execPath, ['--no-warnings', '--loader', mockedDbusLoader, helperPath], {
          encoding: 'utf8',
          env: {HOME: process.env.HOME, LC_ALL: 'C', PATH: process.env.PATH},
          input: JSON.stringify({account: 'account', service: 'service'}),
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 1000,
        })

        expect(result.status).to.equal(0)
        expect(result.stdout).to.equal('{"status":"no-match"}')
        expect(result.stderr).to.equal('')
      })

      it(`rejects malformed stdin without stdout in ${mode} mode${mode === 'built lib' ? ' when built helper is present' : ''}`, function () {
        if (mode === 'built lib' && !existsSync(helperPath)) this.skip()

        const result = runSubprocess(process.execPath, [helperPath], {
          encoding: 'utf8',
          env: {HOME: process.env.HOME, LC_ALL: 'C', PATH: process.env.PATH},
          input: '{malformed json',
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        expect(result.status).to.not.equal(0)
        expect(result.stdout).to.equal('')
        expect(result.stderr).to.equal('')
      })
    }
  })

  describe('Linux child environment', function () {
    it('passes required D-Bus variables to a real subprocess without forwarding secrets', function () {
      withEnvironment({
        ...TEST_CHILD_ENV,
        HEROKU_API_KEY: 'do-not-forward-this-heroku-secret',
      }, () => {
        const env = createChildEnvironment()
        const result = runSubprocess(process.execPath, ['-e', [
          'process.stdout.write(JSON.stringify({',
          '  apiKey: process.env.HEROKU_API_KEY,',
          '  runtime: process.env.XDG_RUNTIME_DIR,',
          '  session: process.env.DBUS_SESSION_BUS_ADDRESS,',
          '  starterAddress: process.env.DBUS_STARTER_ADDRESS,',
          '  starterType: process.env.DBUS_STARTER_BUS_TYPE,',
          '}))',
        ].join('\n')], {encoding: 'utf8', env})

        expect(result.status).to.equal(0)
        expect(JSON.parse(result.stdout)).to.deep.equal({
          runtime: TEST_CHILD_ENV.XDG_RUNTIME_DIR,
          session: TEST_CHILD_ENV.DBUS_SESSION_BUS_ADDRESS,
          starterAddress: TEST_CHILD_ENV.DBUS_STARTER_ADDRESS,
          starterType: TEST_CHILD_ENV.DBUS_STARTER_BUS_TYPE,
        })
        expect(env).to.not.have.property('HEROKU_API_KEY')
      })
    })
  })

  describe('Linux SearchItems helper', function () {
    it('returns locked-match when both locked and unlocked arrays contain items', async function () {
      const {bus, callStub, disconnectStub} = setupBus({body: [['/org/freedesktop/secrets/item/unlocked'], ['/org/freedesktop/secrets/item/locked']]})

      const result = await searchKeyring('account', 'service', () => bus)

      expect(result).to.equal('locked-match')
      expect(disconnectStub.calledOnce).to.be.true
      expect(callStub.calledOnce).to.be.true
      const message = callStub.firstCall.args[0] as Message
      expect(message.destination).to.equal('org.freedesktop.secrets')
      expect(message.path).to.equal('/org/freedesktop/secrets')
      expect(message.interface).to.equal('org.freedesktop.Secret.Service')
      expect(message.member).to.equal('SearchItems')
      expect(message.signature).to.equal('a{ss}')
      expect(message.body).to.deep.equal([{account: 'account', service: 'service'}])
    })

    it('returns match and no-match only for valid unlocked and empty result arrays', async function () {
      const unlockedBus = setupBus({body: [['/org/freedesktop/secrets/item/1'], []]})
      const emptyBus = setupBus({body: [[], []]})

      expect(await searchKeyring('account', 'service', () => unlockedBus.bus)).to.equal('match')
      expect(await searchKeyring('account', 'service', () => emptyBus.bus)).to.equal('no-match')
    })

    it('returns locked-match when only locked matches exist', async function () {
      const lockedBus = setupBus({body: [[], ['/org/freedesktop/secrets/item/locked']]})

      expect(await searchKeyring('account', 'service', () => lockedBus.bus)).to.equal('locked-match')
      expect(lockedBus.disconnectStub.calledOnce).to.be.true
    })

    it('validates all SearchItems paths before classifying mixed results', async function () {
      const invalidBus = setupBus({body: [['/org/freedesktop/secrets/item/unlocked'], ['invalid path']]})

      await expect(searchKeyring('account', 'service', () => invalidBus.bus)).to.be.rejectedWith('Invalid SearchItems item paths')
      expect(invalidBus.disconnectStub.calledOnce).to.be.true
    })

    it('rejects sparse unlocked SearchItems arrays before classifying results', async function () {
      const unlocked: string[] = []
      unlocked.length = 1
      const invalidBus = setupBus({body: [unlocked, ['/org/freedesktop/secrets/item/locked']]})

      await expect(searchKeyring('account', 'service', () => invalidBus.bus)).to.be.rejectedWith('Invalid SearchItems item paths')
      expect(invalidBus.disconnectStub.calledOnce).to.be.true
    })

    it('rejects sparse locked SearchItems arrays before classifying results', async function () {
      const locked: string[] = []
      locked.length = 1
      const invalidBus = setupBus({body: [['/org/freedesktop/secrets/item/unlocked'], locked]})

      await expect(searchKeyring('account', 'service', () => invalidBus.bus)).to.be.rejectedWith('Invalid SearchItems item paths')
      expect(invalidBus.disconnectStub.calledOnce).to.be.true
    })

    it('fails when the D-Bus connection emits an error', async function () {
      const errorBus = setupBus(null)
      errorBus.callStub.returns(new Promise(() => {}))
      const initialErrorListeners = errorBus.bus.listenerCount('error')
      const search = searchKeyring('account', 'service', () => errorBus.bus)
      const rejected = expect(search).to.be.rejectedWith('SearchItems failed')
      errorBus.bus.emit('error', new Error('private D-Bus error'))

      await rejected

      expect(errorBus.disconnectStub.calledOnce).to.be.true
      expect(errorBus.bus.listenerCount('error')).to.equal(initialErrorListeners + 1)
      expect(() => errorBus.bus.emit('error', new Error('late D-Bus error'))).to.not.throw()
      expect(errorBus.bus.listenerCount('error')).to.equal(initialErrorListeners + 1)
    })

    it('times out a stuck SearchItems call and disconnects the bus', async function () {
      const clock = useFakeTimers()
      const timeoutBus = setupBus(null)
      timeoutBus.callStub.returns(new Promise(() => {}))
      const search = searchKeyring('account', 'service', () => timeoutBus.bus)
      const rejected = expect(search).to.be.rejectedWith('SearchItems timed out')

      try {
        await clock.tickAsync(4000)
        await rejected
        expect(timeoutBus.disconnectStub.calledOnce).to.be.true
        expect(timeoutBus.bus.listenerCount('error')).to.equal(1)
        expect(() => timeoutBus.bus.emit('error', new Error('late D-Bus error'))).to.not.throw()
        expect(timeoutBus.bus.listenerCount('error')).to.equal(1)
      } finally {
        clock.restore()
      }
    })

    it('handles late D-Bus errors after public disconnect when another listener is present', async function () {
      const {bus, disconnectStub} = setupBus({body: [[], []]})
      // Existing bus listeners must be preserved when the search listener is replaced.
      bus.on('error', () => {})

      expect(await searchKeyring('account', 'service', () => bus)).to.equal('no-match')
      expect(disconnectStub.calledOnce).to.be.true
      expect(bus.listenerCount('error')).to.equal(2)
      expect(() => bus.emit('error', new Error('late D-Bus error'))).to.not.throw()
      expect(() => bus.emit('error', new Error('another late D-Bus error'))).to.not.throw()
      expect(bus.listenerCount('error')).to.equal(2)
    })

    it('handles a late D-Bus error for direct callers after public disconnect', async function () {
      const {bus, disconnectStub} = setupBus({body: [[], []]})
      const initialErrorListeners = bus.listenerCount('error')

      expect(await searchKeyring('account', 'service', () => bus)).to.equal('no-match')
      expect(disconnectStub.calledOnce).to.be.true
      expect(bus.listenerCount('error')).to.equal(initialErrorListeners + 1)
      expect(() => bus.emit('error', new Error('late D-Bus error'))).to.not.throw()
      expect(() => bus.emit('error', new Error('another late D-Bus error'))).to.not.throw()
      expect(bus.listenerCount('error')).to.equal(initialErrorListeners + 1)
    })

    it('keeps its bus error listener to handle disconnect errors after a SearchItems error', async function () {
      // dbus-next emits MessageBus errors through EventEmitter; model an error during the call.
      // eslint-disable-next-line unicorn/prefer-event-target
      const bus = new EventEmitter() as EventEmitter & {call: (message: Message) => Promise<unknown>; disconnect: () => void}
      const callStub = stub().callsFake(() => {
        bus.emit('error', new Error('D-Bus error'))
        return new Promise(() => {})
      })
      const disconnectStub = stub()
      bus.call = callStub
      bus.disconnect = disconnectStub
      const initialBusErrorListeners = bus.listenerCount('error')

      await expect(searchKeyring('account', 'service', () => bus)).to.be.rejectedWith('SearchItems failed')

      expect(disconnectStub.calledOnce).to.be.true
      expect(bus.listenerCount('error')).to.equal(initialBusErrorListeners + 1)
      expect(() => bus.emit('error', new Error('late D-Bus error'))).to.not.throw()
      expect(() => bus.emit('error', new Error('another late D-Bus error'))).to.not.throw()
      expect(bus.listenerCount('error')).to.equal(initialBusErrorListeners + 1)
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
      expectMinimalChildEnvironment(spawnSyncStub.args[0][2].env)
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
      expectMinimalChildEnvironment(spawnSyncStub.args[0][2].env)
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
      expect(options.env).to.not.have.property('HEROKU_API_KEY')
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
      expectMinimalChildEnvironment(spawnSyncStub.args[0][2].env)
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
