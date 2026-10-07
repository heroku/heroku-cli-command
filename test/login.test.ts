import {Login as CredentialManagerLogin, LoginRequestError} from '@heroku/heroku-credential-manager/login'
import {Config} from '@oclif/core/config'
import {ux} from '@oclif/core/ux'
import {greenBright} from 'ansis'
import {expect, fancy} from 'fancy-test'
import nock from 'nock'
import childProcess from 'node:child_process'
import {EventEmitter} from 'node:events'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import * as sinon from 'sinon'

import {HerokuAPIError} from '../src/api-client.js'
import {Command as CommandBase} from '../src/command.js'
import {setCredentialManagerProvider} from '../src/credential-manager.js'
import {Login, NONINTERACTIVE_LOGIN_ERROR_CODE} from '../src/login.js'
import {prompter} from '../src/prompter.js'
import {restoreCredentialManagerStub} from './helpers/credential-manager-stub.js'

class Command extends CommandBase {
  async run() {}
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const environmentNames = [
  'HEROKU_API_KEY',
  'HEROKU_GIT_HOST',
  'HEROKU_HOST',
  'HEROKU_LEGACY_SSO',
  'HEROKU_LOGIN_HOST',
  'HEROKU_ORGANIZATION',
  'SSO_URL',
] as const
let previousEnvironment: Record<(typeof environmentNames)[number], string | undefined>

const test = fancy.add('config', () => new Config({root: resolve(__dirname, '../package.json')}))
type Delegate = {
  apiClientForToken(token: string): Record<string, unknown>;
  browser: Record<string, unknown>;
  config: Record<string, unknown>;
  environment: {get(name: string): string | undefined};
  fetch: unknown;
  login(options: Record<string, unknown>): Promise<{account: string; token: string}>;
  output: Record<string, unknown>;
  progress: Record<string, unknown>;
  prompt: Record<string, unknown>;
  storage: Record<string, unknown>;
  timers: Record<string, unknown>;
}

function stubBrowserSpawn(): sinon.SinonStub {
  return sinon.stub(childProcess, 'spawn').callsFake((() => {
    // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses EventEmitter semantics
    const child = Object.assign(new EventEmitter(), {pid: 12_345, unref: sinon.stub()})
    setImmediate(() => {
      child.emit('spawn')
      if (process.platform === 'win32') setImmediate(() => child.emit('close', 0))
    })
    return child
  }) as unknown as typeof childProcess.spawn)
}

function provider(overrides: Partial<Parameters<typeof setCredentialManagerProvider>[0]> = {}) {
  const calls = {
    remove: [] as unknown[][],
    save: [] as unknown[][],
  }
  setCredentialManagerProvider({
    async getAuth() {
      throw new Error('No auth found')
    },
    async removeAuth(...args) {
      calls.remove.push(args)
    },
    async saveAuth(...args) {
      calls.save.push(args)
    },
    ...overrides,
  })
  return calls
}

function stubPrompts() {
  return sinon.stub(prompter, 'prompt').callsFake(async (questions: Array<{name: string}>) => {
    const [question] = questions
    const values: Record<string, string> = {
      email: 'test@example.com',
      orgName: 'test-org',
      password: 'test-password',
      secondFactor: '123456',
    }
    return {[question.name]: values[question.name]}
  })
}

describe('Login facade', () => {
  beforeEach(() => {
    previousEnvironment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]])) as typeof previousEnvironment
    for (const name of environmentNames) delete process.env[name]
    provider()
  })

  afterEach(() => {
    for (const name of environmentNames) {
      if (previousEnvironment[name] === undefined) delete process.env[name]
      else process.env[name] = previousEnvironment[name]
    }

    sinon.restore()
    restoreCredentialManagerStub()
    nock.cleanAll()
  })

  test.it('defers invalid login host validation until the first login operation', async ctx => {
    process.env.HEROKU_LOGIN_HOST = 'http://example.com'

    let cmd: Command | undefined
    expect(() => {
      cmd = new Command([], ctx.config)
    }).to.not.throw()

    const error = await cmd!.heroku.login({method: 'browser'}).catch((error: unknown) => error) as Error
    expect(error.message).to.match(/loginHost must be an absolute HTTPS URL/i)
  })

  test.it('defers invalid SSO URL validation until the first login operation', async ctx => {
    process.env.SSO_URL = 'http://example.com/sso'

    let cmd: Command | undefined
    expect(() => {
      cmd = new Command([], ctx.config)
    }).to.not.throw()

    const error = await cmd!.heroku.login({method: 'sso'}).catch((error: unknown) => error) as Error
    expect(error.message).to.match(/ssoUrl must be an absolute HTTPS URL/i)
  })

  test.it('uses loginHost and SSO URL mutations made after construction', async ctx => {
    const login = new Login(ctx.config, new Command([], ctx.config).heroku)
    login.loginHost = 'https://cli-auth.staging.heroku.com'
    process.env.SSO_URL = 'https://sso.heroku.com/saml/mutated/init?cli=true'
    stubBrowserSpawn()
    stubPrompts()
    const stderr = sinon.stub(ux, 'stderr')
    sinon.stub(ux, 'warn')
    sinon.stub(ux.action, 'start')
    sinon.stub(ux.action, 'stop')
    nock('https://api.heroku.com').get('/account').reply(200, {email: 'mutated@example.com'})

    await login.login({method: 'sso'})

    expect(stderr.calledWithExactly(greenBright(process.env.SSO_URL))).to.equal(true)
  })

  test.it('serializes concurrent prompt attempts so each timeout cancels only its own prompt', async ctx => {
    const clock = sinon.useFakeTimers()
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const originalSetRawMode = process.stdin.setRawMode
    Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: true})
    const setRawMode = sinon.stub()
    Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: setRawMode})
    sinon.stub(process.stdin, 'resume').returns(process.stdin)
    sinon.stub(ux, 'stderr')
    sinon.stub(ux.action, 'stop')
    const baselineListeners = process.stdin.listenerCount('data')
    const login = new Login(ctx.config, new Command([], ctx.config).heroku)
    try {
      const first = login.login().then(() => {}, (error: unknown) => error)
      const second = login.login().then(() => {}, (error: unknown) => error)
      await clock.tickAsync(0)
      const activeListeners = process.stdin.listenerCount('data')
      expect(activeListeners).to.be.greaterThan(0)

      await clock.tickAsync(10 * 60_000)
      const firstError = await first as Error
      expect(firstError.message).to.equal('Login timed out')
      expect(process.stdin.listenerCount('data')).to.equal(activeListeners)

      let secondSettled = false
      second.then(() => {
        secondSettled = true
      }).catch(() => {})
      await clock.tickAsync(0)
      expect(secondSettled).to.equal(false)

      await clock.tickAsync(10 * 60_000)
      const secondError = await second as Error
      expect(secondError.message).to.equal('Login timed out')
      expect(process.stdin.listenerCount('data')).to.equal(baselineListeners)
      expect(setRawMode.args).to.deep.equal([[true], [false], [true], [false]])
      expect(clock.countTimers()).to.equal(0)
    } finally {
      clock.restore()
      if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
      else delete (process.stdin as {isTTY?: boolean}).isTTY
      Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: originalSetRawMode})
    }
  })

  test.it('constructs the package Login with command adapters and preserved configuration', async ctx => {
    const cmd = new Command([], ctx.config)
    const login = new Login(ctx.config, cmd.heroku)
    const delegate = (login as unknown as {createDelegate(): Delegate}).createDelegate()

    expect(delegate.config).to.include({
      apiHost: 'api.heroku.com',
      apiUrl: 'https://api.heroku.com',
      credentialService: 'heroku-cli',
      dataDir: ctx.config.dataDir,
      gitHost: 'git.heroku.com',
      loginHost: 'https://cli-auth.heroku.com',
      requestTimeoutMs: 60_000,
      timeoutMs: 10 * 60_000,
    })
    expect(delegate.config.hostname).to.be.a('string').and.not.equal('')
    expect(delegate.fetch).to.be.a('function')
    expect(delegate.prompt).to.include.keys('accessToken', 'email', 'loginMethod', 'organization', 'password', 'secondFactor')
    expect(delegate.browser).to.include.keys('open')
    expect(delegate.output).to.include.keys('warn', 'write')
    expect(delegate.progress).to.include.keys('start', 'stop')
    expect(delegate.environment.get('PATH')).to.equal(process.env.PATH)
    expect(delegate.storage).to.include.keys('deleteLoginState', 'getAuth', 'hasNativeStorage', 'readLoginState', 'removeAuth', 'saveAuth', 'writeLoginState')
    expect(delegate.timers).to.include.keys('clearTimeout', 'setTimeout')

    const platform = delegate.apiClientForToken('operation-token')
    expect(platform).to.include.keys('delete', 'get')
  })

  test.it('preserves custom API, Git, login, SSO, and credential-service configuration', async ctx => {
    process.env.HEROKU_HOST = 'staging.heroku.com'
    process.env.HEROKU_GIT_HOST = 'git.custom.heroku.com'
    process.env.HEROKU_LOGIN_HOST = 'https://cli-auth.staging.heroku.com'
    process.env.SSO_URL = 'https://sso.heroku.com/saml/custom/init?cli=true'

    const login = new Login(ctx.config, new Command([], ctx.config).heroku)
    const delegate = (login as unknown as {createDelegate(): Delegate}).createDelegate()

    expect(delegate.config).to.include({
      apiHost: 'api.staging.heroku.com',
      apiUrl: 'https://api.staging.heroku.com',
      credentialService: 'heroku-cli@api.staging.heroku.com',
      gitHost: 'git.custom.heroku.com',
      loginHost: 'https://cli-auth.staging.heroku.com',
      ssoUrl: 'https://sso.heroku.com/saml/custom/init?cli=true',
    })
  })

  for (const [alias, method] of [['b', 'browser'], ['i', 'interactive'], ['s', 'sso']] as const) {
    test.it(`preserves the ${alias} login method alias`, async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const loginStub = sinon.stub(CredentialManagerLogin.prototype, 'login').resolves({account: 'new@example.com', token: 'new-token'})
      const setAuthEntry = sinon.spy(cmd.heroku, 'setAuthEntry')

      await login.login({method: alias})

      expect(loginStub.calledOnceWithExactly({method})).to.equal(true)
      expect(setAuthEntry.calledOnceWithExactly({account: 'new@example.com', token: 'new-token'})).to.equal(true)
    })
  }

  test.it('runs interactive login through the package, pre-fills the prior account, persists, then updates memory once', async ctx => {
    const questions: Array<{default?: string; name: string}> = []
    sinon.stub(prompter, 'prompt').callsFake(async (promptQuestions: Array<{default?: string; name: string}>) => {
      const [question] = promptQuestions
      questions.push(question)
      return question.name === 'email' ? {email: 'new@example.com'} : {password: 'password'}
    })
    const calls = provider({
      async getAuth() {
        return {account: 'previous@example.com', token: 'old-token'}
      },
    })
    nock('https://api.heroku.com')
      .post('/oauth/authorizations', {description: /^Heroku CLI login from .+/, expires_in: 12_345, scope: ['global']})
      .reply(200, {access_token: {token: 'new-token'}, user: {email: 'new@example.com'}})
    const cmd = new Command([], ctx.config)
    const setAuthEntry = sinon.spy(cmd.heroku, 'setAuthEntry')

    await cmd.heroku.login({expiresIn: 12_345, method: 'interactive'})

    expect(questions.find(question => question.name === 'email')?.default).to.equal('previous@example.com')
    expect(calls.save).to.deep.equal([['new@example.com', 'new-token', ['api.heroku.com', 'git.heroku.com'], 'heroku-cli']])
    expect(setAuthEntry.calledOnceWithExactly({account: 'new@example.com', token: 'new-token'})).to.equal(true)
    expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'new@example.com', token: 'new-token'})
  })

  test.it('prompts for a second factor through the package', async ctx => {
    const promptStub = stubPrompts()
    nock('https://api.heroku.com')
      .post('/oauth/authorizations')
      .reply(401, {id: 'two_factor', message: 'two factor required'})
      .post('/oauth/authorizations')
      .matchHeader('heroku-two-factor-code', '123456')
      .reply(200, {access_token: {token: 'new-token'}, user: {email: 'test@example.com'}})

    await new Command([], ctx.config).heroku.login({method: 'interactive'})

    expect(promptStub.args.flatMap(call => call[0]).some(question => question.name === 'secondFactor')).to.equal(true)
  })

  test.it('preserves default expiration, maximum validation, and device-trust messaging', async ctx => {
    stubPrompts()
    const defaultExpiration = nock('https://api.heroku.com')
      .post('/oauth/authorizations', {description: /^Heroku CLI login from .+/, expires_in: 60 * 60 * 24 * 30, scope: ['global']})
      .reply(401, {id: 'device_trust_required', message: 'original message'})
    const cmd = new Command([], ctx.config)

    const deviceTrust = await cmd.heroku.login({method: 'interactive'}).catch((error: unknown) => error) as Error
    expect(deviceTrust.message).to.contain('The interactive flag requires Two-Factor Authentication')
    expect(deviceTrust.message).to.contain('Error ID: device_trust_required')
    expect(defaultExpiration.isDone()).to.equal(true)

    const tooLong = await cmd.heroku.login({expiresIn: 60 * 60 * 24 * 31, method: 'interactive'}).catch((error: unknown) => error) as Error
    expect(tooLong.message).to.equal('Cannot set an expiration longer than thirty days')
  })

  test.it('rejects login while HEROKU_API_KEY is set', async ctx => {
    process.env.HEROKU_API_KEY = 'environment-token'
    const error = await new Command([], ctx.config).heroku.login({method: 'interactive'}).catch((error: unknown) => error) as Error

    expect(error.message).to.equal('Cannot log in with HEROKU_API_KEY set')
  })

  test.it('pre-fills from the APIClient in-memory account when persistent lookup is unavailable', async ctx => {
    const questions: Array<{default?: string; name: string}> = []
    sinon.stub(prompter, 'prompt').callsFake(async (promptQuestions: Array<{default?: string; name: string}>) => {
      const [question] = promptQuestions
      questions.push(question)
      return question.name === 'email' ? {email: 'new@example.com'} : {password: 'password'}
    })
    provider()
    nock('https://api.heroku.com').post('/oauth/authorizations').reply(200, {
      access_token: {token: 'new-token'},
      user: {email: 'new@example.com'},
    })
    const cmd = new Command([], ctx.config)
    cmd.heroku.setAuthEntry({account: 'memory@example.com', token: 'memory-token'})

    await cmd.heroku.login({method: 'interactive'})

    expect(questions.find(question => question.name === 'email')?.default).to.equal('memory@example.com')
  })

  test.it('does not replace in-memory auth when login fails', async ctx => {
    stubPrompts()
    nock('https://api.heroku.com').post('/oauth/authorizations').reply(401, {id: 'unauthorized', message: 'bad credentials'})
    const cmd = new Command([], ctx.config)
    cmd.heroku.setAuthEntry({account: 'old@example.com', token: 'old-token'})
    const setAuthEntry = sinon.spy(cmd.heroku, 'setAuthEntry')

    const error = await cmd.heroku.login({method: 'interactive'}).catch((error: unknown) => error)

    expect(error).to.be.instanceOf(HerokuAPIError)
    expect(setAuthEntry.called).to.equal(false)
    expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'old@example.com', token: 'old-token'})
  })

  test.it('maps LoginRequestError to a neutral HerokuAPIError without sensitive fields', async ctx => {
    const cmd = new Command([], ctx.config)
    const login = new Login(ctx.config, cmd.heroku)
    sinon.stub(CredentialManagerLogin.prototype, 'login').rejects(new LoginRequestError(401, {
      id: 'unauthorized',
      message: 'request rejected',
      resource: 'authorization',
      token: 'must-not-appear',
    }))

    const error = await login.login({method: 'interactive'}).catch((error: unknown) => error) as HerokuAPIError

    expect(error).to.be.instanceOf(HerokuAPIError)
    expect(error.message).to.equal('request rejected\n\nError ID: unauthorized')
    expect(JSON.stringify(error)).to.not.contain('must-not-appear')
    expect(error.http.statusCode).to.equal(401)
  })

  test.it('completes browser login and always prints the manual URL', async ctx => {
    const spawn = stubBrowserSpawn()
    const stderr = sinon.stub(ux, 'stderr')
    const warn = sinon.stub(ux, 'warn')
    sinon.stub(ux.action, 'start')
    const stop = sinon.stub(ux.action, 'stop')
    const browserUrl = 'https://cli-auth.heroku.com/auth/cli/browser/request?requestor=test'
    nock('https://cli-auth.heroku.com')
      .post('/auth')
      .reply(200, {browser_url: '/auth/cli/browser/request?requestor=test', cli_url: '/auth/cli/browser/request', token: 'temporary'})
      .get('/auth/cli/browser/request')
      .reply(200, {access_token: 'browser-token'})
    nock('https://api.heroku.com').get('/account').reply(200, {email: 'browser@example.com'})

    await new Command([], ctx.config).heroku.login({method: 'browser'})

    expect(spawn.calledOnce).to.equal(true)
    expect(warn.calledWithExactly('If browser does not open, visit:')).to.equal(true)
    expect(stderr.calledWithExactly(greenBright(browserUrl))).to.equal(true)
    expect(stop.called).to.equal(true)
  })

  test.it('keeps browser opener failure nonfatal with the manual URL visible', async ctx => {
    sinon.stub(childProcess, 'spawn').throws(new Error('browser unavailable'))
    const stderr = sinon.stub(ux, 'stderr')
    const warn = sinon.stub(ux, 'warn')
    sinon.stub(ux.action, 'start')
    sinon.stub(ux.action, 'stop')
    const browserUrl = 'https://cli-auth.heroku.com/auth/cli/browser/request'
    nock('https://cli-auth.heroku.com')
      .post('/auth')
      .reply(200, {browser_url: '/auth/cli/browser/request', cli_url: '/auth/cli/browser/poll', token: 'temporary'})
      .get('/auth/cli/browser/poll')
      .reply(200, {access_token: 'browser-token'})
    nock('https://api.heroku.com').get('/account').reply(200, {email: 'browser@example.com'})

    await new Command([], ctx.config).heroku.login({method: 'browser'})

    expect(stderr.calledWithExactly(greenBright(browserUrl))).to.equal(true)
    expect(warn.calledWithExactly('Cannot open browser. Continue with the manual URL above.')).to.equal(true)
  })

  test.it('observes a later browser child failure without failing the login', async ctx => {
    // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses EventEmitter semantics
    const child = Object.assign(new EventEmitter(), {pid: 12_345, unref: sinon.stub()})
    sinon.stub(childProcess, 'spawn').callsFake((() => {
      setImmediate(() => {
        child.emit('spawn')
        if (process.platform === 'win32') setImmediate(() => child.emit('close', 0))
      })
      return child
    }) as unknown as typeof childProcess.spawn)
    const warn = sinon.stub(ux, 'warn')
    sinon.stub(ux, 'stderr')
    sinon.stub(ux.action, 'start')
    sinon.stub(ux.action, 'stop')
    nock('https://cli-auth.heroku.com')
      .post('/auth')
      .reply(200, {browser_url: '/browser', cli_url: '/poll', token: 'temporary'})
      .get('/poll')
      .reply(200, {access_token: 'browser-token'})
    nock('https://api.heroku.com').get('/account').reply(200, {email: 'browser@example.com'})
    await new Command([], ctx.config).heroku.login({method: 'browser'})
    child.emit('error', new Error('late browser failure'))
    child.emit('close', 1)

    expect(warn.calledWithExactly(sinon.match.has('message', 'late browser failure'))).to.equal(true)
    expect(warn.calledWithExactly('Cannot open browser. Continue with the manual URL above.')).to.equal(true)
  })

  test.it('runs SSO through package prompt, browser, validation, and persistence adapters', async ctx => {
    process.env.SSO_URL = 'https://sso.heroku.com/saml/test-org/init?cli=true'
    stubBrowserSpawn()
    const prompts = stubPrompts()
    const stderr = sinon.stub(ux, 'stderr')
    sinon.stub(ux, 'warn')
    sinon.stub(ux.action, 'start')
    sinon.stub(ux.action, 'stop')
    nock('https://api.heroku.com').get('/account').matchHeader('authorization', 'Bearer test-password').reply(200, {email: 'sso@example.com'})

    await new Command([], ctx.config).heroku.login({method: 'sso'})

    expect(prompts.args.flatMap(call => call[0]).some(question => question.message === 'Access token')).to.equal(true)
    expect(stderr.calledWithExactly(greenBright(process.env.SSO_URL))).to.equal(true)
  })

  test.it('rejects implicit non-TTY login with the command error code but permits an explicit method', async ctx => {
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: false})
    const cmd = new Command([], ctx.config)
    const login = new Login(ctx.config, cmd.heroku)
    const delegateLogin = sinon.stub(CredentialManagerLogin.prototype, 'login').resolves({account: 'new@example.com', token: 'new-token'})
    try {
      const error = await login.login().catch((error: unknown) => error) as {code?: string; oclif?: {exit?: number}}
      expect(error.code).to.equal(NONINTERACTIVE_LOGIN_ERROR_CODE)
      expect(error.oclif?.exit).to.equal(1)
      expect(delegateLogin.called).to.equal(false)

      await login.login({method: 'interactive'})
      expect(delegateLogin.calledOnceWithExactly({method: 'interactive'})).to.equal(true)
    } finally {
      if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
      else delete (process.stdin as {isTTY?: boolean}).isTTY
    }
  })

  for (const [key, exit] of [['q', 2], ['\u0003', 130]] as const) {
    test.it(`maps ${key === 'q' ? 'q' : 'Ctrl-C'} cancellation to command exit ${exit} and restores raw mode`, async ctx => {
      const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
      const originalSetRawMode = process.stdin.setRawMode
      Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: true})
      const setRawMode = sinon.stub()
      Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: setRawMode})
      sinon.stub(process.stdin, 'resume').returns(process.stdin)
      sinon.stub(ux, 'stderr')
      sinon.stub(ux, 'stdout')
      const exitError = Object.assign(new Error('cancelled'), {oclif: {exit}})
      const uxError = sinon.stub(ux, 'error').throws(exitError)
      setTimeout(() => process.stdin.emit('data', Buffer.from(key)), 0)
      try {
        const error = await new Login(ctx.config, new Command([], ctx.config).heroku).login().catch((error: unknown) => error)
        expect(error).to.equal(exitError)
        expect(uxError.calledOnceWithExactly('Login cancelled by user', {exit})).to.equal(true)
        expect(setRawMode.args).to.deep.equal([[true], [false]])
      } finally {
        if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
        else delete (process.stdin as {isTTY?: boolean}).isTTY
        Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: originalSetRawMode})
      }
    })
  }

  test.it('cancels a timed-out method prompt and restores raw mode and progress', async ctx => {
    const clock = sinon.useFakeTimers()
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const originalSetRawMode = process.stdin.setRawMode
    Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: true})
    const setRawMode = sinon.stub()
    Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: setRawMode})
    sinon.stub(process.stdin, 'resume').returns(process.stdin)
    sinon.stub(ux, 'stderr')
    const stop = sinon.stub(ux.action, 'stop')
    const listeners = process.stdin.listenerCount('data')
    try {
      const pending = new Login(ctx.config, new Command([], ctx.config).heroku).login()
      const result = pending.then(() => {}, (error: unknown) => error)
      await clock.tickAsync(10 * 60_000)
      const error = await result as Error

      expect(error.message).to.equal('Login timed out')
      expect(process.stdin.listenerCount('data')).to.equal(listeners)
      expect(setRawMode.args).to.deep.equal([[true], [false]])
      expect(stop.called).to.equal(true)
    } finally {
      clock.restore()
      if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
      else delete (process.stdin as {isTTY?: boolean}).isTTY
      Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: originalSetRawMode})
    }
  })

  test.it('stops progress when a browser request fails', async ctx => {
    stubBrowserSpawn()
    sinon.stub(ux, 'stderr')
    sinon.stub(ux, 'warn')
    sinon.stub(ux.action, 'start')
    const stop = sinon.stub(ux.action, 'stop')
    nock('https://cli-auth.heroku.com')
      .post('/auth')
      .reply(200, {browser_url: '/browser', cli_url: '/poll', token: 'temporary'})
      .get('/poll')
      .reply(401, {message: 'poll failed'})

    await new Command([], ctx.config).heroku.login({method: 'browser'}).catch(() => {})

    expect(stop.called).to.equal(true)
  })

  test.it('delegates complete-entry logout with single package-owned persistent cleanup', async ctx => {
    const calls = provider()
    nock('https://api.heroku.com')
      .delete('/oauth/sessions/~').matchHeader('authorization', 'Bearer logout-token').reply(200, {})
      .get('/oauth/authorizations').matchHeader('authorization', 'Bearer logout-token').reply(200, [])
      .get('/oauth/authorizations/~').matchHeader('authorization', 'Bearer logout-token').reply(404, {id: 'not_found', resource: 'authorization'})
    const login = new Login(ctx.config, new Command([], ctx.config).heroku)

    await login.logoutEntry({account: 'logout@example.com', token: 'logout-token'})

    expect(calls.remove).to.deep.equal([['logout@example.com', ['api.heroku.com', 'git.heroku.com'], 'heroku-cli', 'logout-token']])
  })

  test.it('uses narrow remote-only logout for an account-less environment token', async ctx => {
    const calls = provider()
    nock('https://api.heroku.com')
      .delete('/oauth/sessions/~').matchHeader('authorization', 'Bearer environment-token').reply(401, {})
      .get('/oauth/authorizations').matchHeader('authorization', 'Bearer environment-token').reply(401, {})
    const login = new Login(ctx.config, new Command([], ctx.config).heroku)

    await login.logout('environment-token')

    expect(calls.remove).to.deep.equal([])
  })
})
