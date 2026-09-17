/* eslint-disable n/no-extraneous-import -- installed integration dependency is intentionally local until package metadata lands */
import {
  LoginCancelledError,
  LoginHttpError,
} from '@heroku/heroku-credential-manager/login'
import {HTTP, HTTPError} from '@heroku/http-call'
import {Config} from '@oclif/core/config'
import {ux} from '@oclif/core/ux'
import ansis from 'ansis'
import {expect as chaiExpect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'
import debug from 'debug'
import {expect, fancy} from 'fancy-test'
import nock from 'nock'
import childProcess from 'node:child_process'
import {EventEmitter, once} from 'node:events'
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import {
  ClientRequest,
  createServer as createHttpServer,
  Server,
} from 'node:http'
import {createServer as createHttpsServer} from 'node:https'
import {AddressInfo, createConnection} from 'node:net'
import {tmpdir} from 'node:os'
import {dirname, resolve} from 'node:path'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import * as sinon from 'sinon'
import {stderr} from 'stdout-stderr'

import {HerokuAPIError} from '../src/api-client.js'
import {Command as CommandBase} from '../src/command.js'
import {setCredentialManagerProvider} from '../src/credential-manager.js'
import {Login, LoginHttpAdapter} from '../src/login.js'
import {prompter} from '../src/prompter.js'
import {vars} from '../src/vars.js'
import {restoreCredentialManagerStub, stubCredentialManager} from './helpers/credential-manager-stub.js'

use(chaiAsPromised)

class Command extends CommandBase {
  async run() {}
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const httpCallEnvironment = process.env

async function rejectionWithin(promise: Promise<unknown>, timeoutMs = 1000): Promise<Error> {
  let timeout: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Request did not settle')), timeoutMs)
      }),
    ])
  } catch (error) {
    return error as Error
  } finally {
    if (timeout) clearTimeout(timeout)
  }

  throw new Error('Expected request to reject')
}

const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUefv7vepDVMghdKTNoZX/RulqFrUwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkxMTE5MjM0OFoXDTM2MDkw
ODE5MjM0OFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAqht4FAy0pof8lxou+1FVzfDGdM3/PHMRxjTab33AS58l
ajTfR5qqfB7eIhqvwvZ2liV74OGz+KbEDnSx5f0qmHtAlGOodEQBWaYK+ngbTfWg
3xfQncE16AgAiZlYosSn8/GbzTTs+Kv4juLLxFvkf3dlYozU7VLBKm3u8p3uVpmA
VQeaajcbGe2C4YsCxXFjvnip3ywIsN2jgh1dNNea+SeRl/H6NHczSShT/+gJdqRR
EvVO8njcCgvzcWHTaB5rOD2PWAnxzLzKSWkUwe9abqS4DgXfZG3P9jt/J8r/N7eM
akmfIDiYvyGeE3rOw3Z3oaqWwi3LVcpi7bfoRxaR5QIDAQABo28wbTAdBgNVHQ4E
FgQUeRsq6RFw2mRy3FmQNwHisUJk6eYwHwYDVR0jBBgwFoAUeRsq6RFw2mRy3FmQ
NwHisUJk6eYwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAHORkMQj4ma1qOyXsWxdbL7J9TMs4wld
H+Sb0GZzS4od1m2IugXrCJZ+kIY/sRuC7nMvbAzuuoPBqVnjP4pHX3PKegaPlwZl
8W61lcySIlJO7KnpDkHQtR6368dstsZF29Ux8yXOVojSnRSGnsdBhhVH9YkO++sU
w1UBG83YmpHdZdfL1kzOXhzwanRtSP3ZdD1kShGVdhTaN9mQGnDw1Q43uvgiaWet
1ercWotLZ0W0XFVYxBqxJoO5iR2qvQewyRbP15tVWgRaBcnrGwUCV23xZmkY4eSw
V0CVOKxAyClQo9iw1Q1kNEG/NPzB8xw1DjLjbz7H2v86GJYniMYlIlw=
-----END CERTIFICATE-----`

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCqG3gUDLSmh/yX
Gi77UVXN8MZ0zf88cxHGNNpvfcBLnyVqNN9Hmqp8Ht4iGq/C9naWJXvg4bP4psQO
dLHl/SqYe0CUY6h0RAFZpgr6eBtN9aDfF9CdwTXoCACJmViixKfz8ZvNNOz4q/iO
4svEW+R/d2VijNTtUsEqbe7yne5WmYBVB5pqNxsZ7YLhiwLFcWO+eKnfLAiw3aOC
HV0015r5J5GX8fo0dzNJKFP/6Al2pFES9U7yeNwKC/NxYdNoHms4PY9YCfHMvMpJ
aRTB71pupLgOBd9kbc/2O38nyv83t4xqSZ8gOJi/IZ4Tes7DdnehqpbCLctVymLt
t+hHFpHlAgMBAAECggEAJctenY3JIWr7WxMtNxd2KgCCB3exatviKhiaI8Vb0TF1
3agLp9wcXuF41zj4rieWZ3vCj092bhuXWeLhl8jtCt3vlkiiJ9roNePncoj3ABY/
/PFMn5BLCtekTu4sPFXXPyMCS9CjigijfBO11FXaadu8Qe4qbORDGMs+GNewGbs6
YdvrTr5V1nHfnLfXj2mIrWJOC+IgZ09BIL4K85fhhqbqMc4BnQAln5Abs5WlyCj9
r/DsKvhvq3RE8wmBZ4Vjx+erMDH2hIyepNa+aub4WTNnWY/aU2y99mQf0k2evX24
z/Uzoyl/sRVpcUlWxv7zn/X+O7x0zHsSL30JSJULbQKBgQDciuG22XEV3Wlo3i6u
ZKtqc8Z6dJ64XDPHyp5ky4kXkCL4kSsNfFqdDHH1jpbezZ448oLxIlD3tjuMYpgT
OFSCg51mjpMvsD0fBWDdqN3+NOjRN00UCRg06rMdIl2L5zXLOnsSooyGrUFZT43E
DEmIds/y7yiICb1SZIjfmjwVNwKBgQDFdMSycxXLNGYJZ/PN7hbmBjMwRj5nfr3J
pLLbnqap1Vh6/DCLlTeZJKX/BGm0HRBURfROqPTpqAv16tOWpE2RwuTG8y5zp6tN
W0ADc1cru8lb9yNWpdelpOjh5j+QDsw5KqNA3iNKlUs0s4/KPUWtfEwEixVtnbxR
6RpYRaVfwwKBgCY31weVxNgSJ3spzZMhFOd8qq972CmAqOR9g1daQiaYLsc+eOR8
YUOH7ZOtIw33Oe0KcZCR7tAOf2FDkLD7+QEpB7THDlCcTOs8Rl4DLn0n9BSVbcEE
FnLNHT72PpnI9nSCbON80bdg/MsaUynfKzr/w+eIdFCmx20oyONe2fyfAoGBAKpL
fOES1Hb+6Amwt9qhPup/6mH2ExgbfP+Nphw3hjHvKHJZUlzwApV3wBpi6e9HKbAk
7QFyQlfKcRZUwsunRKcz2S+kyClDMEB1NI5FSacUPCOuz7GJMqVPxvIdLDDIMmYT
Wd02OGW4wLXhL2AS3Cc1jjJU6dQyOBrE2c3Ls0cVAoGAYX9VpzGJ6HWqwdBgIXsQ
/kk2ARshWUBtwEd3McKe4N9ro0L9HSDr5tpgwcb4aHaPvqzZKj/aQakJXOKLkNAX
R/XV93tSEJAE9uQ92b80infCGi7XJ93cmH2pfc7xcKy2hyJsmvPUwgIUaO9jl8pc
pNUmp/0K2Xp0nykN6pvcl/E=
-----END PRIVATE KEY-----`

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.()
  if (server.listening) server.close()
}

function useDeterministicLoginEnvironment(): () => void {
  const names = [
    'HEROKU_API_KEY',
    'HEROKU_API_TOKEN',
    'HEROKU_API_URL',
    'HEROKU_GIT_HOST',
    'HEROKU_HOST',
    'HEROKU_LOGIN_HOST',
    'HEROKU_ORGANIZATION',
    'HEROKU_TESTING_HEADLESS_LOGIN',
    'SSO_URL',
  ]
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  for (const name of names) delete process.env[name]
  const previousNetrcWrite = process.env.HEROKU_NETRC_WRITE
  process.env.HEROKU_NETRC_WRITE = 'true'

  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }

    if (previousNetrcWrite === undefined) delete process.env.HEROKU_NETRC_WRITE
    else process.env.HEROKU_NETRC_WRITE = previousNetrcWrite
  }
}

function stubBrowserSpawn(): sinon.SinonStub {
  return sinon.stub(childProcess, 'spawn').callsFake((() => {
    // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses EventEmitter semantics
    const child = Object.assign(new EventEmitter(), {
      pid: 12_345,
      unref: sinon.stub(),
    })
    setImmediate(() => child.emit('spawn'))
    return child
  }) as typeof childProcess.spawn)
}

const test = fancy
  .add('config', () => {
    const config = new Config({root: resolve(__dirname, '../package.json')})
    return config
  })

describe('login with interactive', () => {
  let api: nock.Scope

  beforeEach(() => {
    api = nock('https://api.heroku.com')
    api.delete('/oauth/sessions/~').reply(200, {})
    api.get('/oauth/authorizations').reply(200, [])
    api.get('/oauth/authorizations/~').reply(200, {})

    stubCredentialManager()

    sinon.stub(prompter, 'prompt').callsFake(async (questions: any[]) => {
      const answers: any = {}

      for (const q of questions) {
        if (q.name === 'email') answers.email = 'test@example.com'
        if (q.name === 'password') answers.password = 'test-password'
        if (q.name === 'secondFactor') answers.secondFactor = '123456'
        if (q.name === 'action') answers.action = 'y'
        if (q.name === 'orgName') answers.orgName = 'test-org'
      }

      return answers
    })
  })

  afterEach(() => {
    sinon.restore()
    restoreCredentialManagerStub()
    nock.cleanAll()
  })

  test
    .it('persists through the package storage adapter and updates APIClient auth', async ctx => {
      const saveCalls: Array<{account: string; hosts: string[]; service?: string; token: string}> = []
      setCredentialManagerProvider({
        async getAuth() {
          throw new Error('No auth found')
        },
        async removeAuth() {},
        async saveAuth(account, token, hosts, service) {
          saveCalls.push({
            account,
            hosts,
            service,
            token,
          })
        },
      })
      api.post('/oauth/authorizations').reply(200, {
        access_token: {token: 'persisted-token'},
        user: {email: 'test@example.com'},
      })

      const cmd = new Command([], ctx.config)
      await cmd.heroku.login({method: 'interactive'})

      expect(saveCalls).to.deep.equal([{
        account: 'test@example.com',
        hosts: ['api.heroku.com', 'git.heroku.com'],
        service: 'heroku-cli',
        token: 'persisted-token',
      }])
      expect(await cmd.heroku.getAuthEntry()).to.deep.equal({
        account: 'test@example.com',
        token: 'persisted-token',
      })
    })

  test
    .it('propagates a generic save failure without updating APIClient auth or login state', async ctx => {
      const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'login-save-failure-'))
      const saveFailure = new Error('credential save failed')
      setCredentialManagerProvider({
        async getAuth() {
          throw new Error('No auth found')
        },
        async removeAuth() {},
        async saveAuth() {
          throw saveFailure
        },
      })
      api.post('/oauth/authorizations').reply(200, {
        access_token: {token: 'unsaved-token'},
        user: {email: 'unsaved@example.com'},
      })

      try {
        const config = {...ctx.config, dataDir: temporaryDirectory} as Config
        const cmd = new Command([], config)

        await chaiExpect(cmd.heroku.login({method: 'interactive'})).to.be.rejectedWith(saveFailure.message)

        expect(await cmd.heroku.getAuthEntry()).to.equal(undefined)
        await chaiExpect(readFile(resolve(temporaryDirectory, 'login.json'), 'utf8')).to.be.rejected
      } finally {
        await rm(temporaryDirectory, {force: true, recursive: true})
      }
    })

  test
    .it('derives an isolated credential service for a custom API host without writing global login state', async ctx => {
      const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'custom-login-'))
      const saveCalls: Array<{account: string; hosts: string[]; service?: string; token: string}> = []
      const customVars = {
        apiHost: 'api.staging.heroku.com:8443',
        apiUrl: 'https://api.staging.heroku.com:8443',
        gitHost: 'staging.heroku.com',
        gitPrefixes: [],
        host: 'https://api.staging.heroku.com:8443',
        httpGitHost: 'git.staging.heroku.com',
      }
      setCredentialManagerProvider({
        async getAuth() {
          throw new Error('No auth found')
        },
        async removeAuth() {},
        async saveAuth(account, token, hosts, service) {
          saveCalls.push({
            account,
            hosts,
            service,
            token,
          })
        },
      })
      const customApi = nock(customVars.apiUrl)
        .post('/oauth/authorizations')
        .reply(200, {
          access_token: {token: 'custom-token'},
          user: {email: 'custom@example.com'},
        })

      try {
        const config = {...ctx.config, dataDir: temporaryDirectory} as Config
        const client = new (await import('../src/api-client.js')).APIClient(config, {}, customVars)
        await client.login({method: 'interactive'})

        expect(saveCalls).to.deep.equal([{
          account: 'custom@example.com',
          hosts: ['api.staging.heroku.com:8443', 'git.staging.heroku.com'],
          service: 'heroku-cli@api.staging.heroku.com:8443',
          token: 'custom-token',
        }])
        await chaiExpect(readFile(resolve(temporaryDirectory, 'login.json'), 'utf8')).to.be.rejected
        customApi.done()
      } finally {
        await rm(temporaryDirectory, {force: true, recursive: true})
      }
    })

  test
    .it('discovers and removes custom native auth across clients without disturbing production state', async ctx => {
      const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'custom-native-lifecycle-'))
      const customVars = {
        apiHost: 'api.staging.heroku.com:8443',
        apiUrl: 'https://api.staging.heroku.com:8443',
        gitHost: 'staging.heroku.com',
        gitPrefixes: [],
        host: 'https://api.staging.heroku.com:8443',
        httpGitHost: 'git.staging.heroku.com',
      }
      const credentials = new Map<string, {account: string; token: string}>()
      const key = (service: string | undefined, account: string | undefined) => `${service}\0${account}`
      credentials.set(key('heroku-cli', 'production@example.com'), {
        account: 'production@example.com',
        token: 'production-token',
      })
      setCredentialManagerProvider({
        async getAuth(account, host, service) {
          const entry = credentials.get(key(service, account))
          if (!entry) throw new Error(`No auth found for ${host}`)
          return entry
        },
        async removeAuth(account, _hosts, service, expectedToken) {
          const storageKey = key(service, account)
          if (credentials.get(storageKey)?.token === expectedToken) credentials.delete(storageKey)
        },
        async saveAuth(account, token, _hosts, service) {
          credentials.set(key(service, account), {account, token})
        },
      })
      await writeFile(resolve(temporaryDirectory, 'login.json'), '{"account":"production@example.com"}\n')
      const customApi = nock(customVars.apiUrl)
        .post('/oauth/authorizations')
        .reply(200, {
          access_token: {token: 'custom-token'},
          user: {email: 'custom@example.com'},
        })
        .delete('/oauth/sessions/~')
        .matchHeader('authorization', 'Bearer custom-token')
        .reply(200, {})
        .get('/oauth/authorizations')
        .matchHeader('authorization', 'Bearer custom-token')
        .reply(200, [])
        .get('/oauth/authorizations/~')
        .matchHeader('authorization', 'Bearer custom-token')
        .reply(404, {id: 'not_found', resource: 'authorization'})

      try {
        const config = {...ctx.config, dataDir: temporaryDirectory} as Config
        await new (await import('../src/api-client.js')).APIClient(config, {}, customVars).login({method: 'interactive'})

        const freshCustomClient = new (await import('../src/api-client.js')).APIClient(config, {}, customVars)
        expect(await freshCustomClient.getAuthEntry()).to.deep.equal({
          account: 'custom@example.com',
          token: 'custom-token',
        })
        const freshProductionClient = new (await import('../src/api-client.js')).APIClient(config)
        expect(await freshProductionClient.getAuthEntry()).to.deep.equal({
          account: 'production@example.com',
          token: 'production-token',
        })

        await freshCustomClient.logout()

        expect(await new (await import('../src/api-client.js')).APIClient(config, {}, customVars).getAuthEntry()).to.be.undefined
        expect(await new (await import('../src/api-client.js')).APIClient(config).getAuthEntry()).to.deep.equal({
          account: 'production@example.com',
          token: 'production-token',
        })
        expect(await readFile(resolve(temporaryDirectory, 'login.json'), 'utf8'))
          .to.equal('{"account":"production@example.com"}\n')
        customApi.done()
      } finally {
        await rm(temporaryDirectory, {force: true, recursive: true})
      }
    })

  test
    .it('serializes direct lifecycle calls so old logout cleanup cannot delete newer login state', async ctx => {
      const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'login-lifecycle-race-'))
      const config = {...ctx.config, dataDir: temporaryDirectory} as Config
      const cmd = new Command([], config)
      const login = new Login(config, cmd.heroku)
      let releaseLogout!: () => void
      let logoutStarted!: () => void
      const logoutStartedPromise = new Promise<void>(resolveStarted => {
        logoutStarted = resolveStarted
      })
      const releaseLogoutPromise = new Promise<void>(resolveRelease => {
        releaseLogout = resolveRelease
      })
      const {delegate} = login as any
      sinon.stub(delegate, 'logout').callsFake(async () => {
        logoutStarted()
        await releaseLogoutPromise
        const {deleteLoginState} = await import('../src/credential-manager-core/lib/login-state.js')
        await deleteLoginState(temporaryDirectory)
      })
      sinon.stub(delegate, 'login').callsFake(async () => {
        const {writeLoginState} = await import('../src/credential-manager-core/lib/login-state.js')
        await writeLoginState(temporaryDirectory, 'new@example.com')
        return {account: 'new@example.com', token: 'new-token'}
      })
      await writeFile(resolve(temporaryDirectory, 'login.json'), '{"account":"old@example.com"}\n')

      try {
        const oldLogout = login.logout({account: 'old@example.com', token: 'old-token'})
        await logoutStartedPromise
        const newerLogin = login.login({method: 'interactive'})
        await new Promise<void>(resolveWait => {
          setTimeout(resolveWait, 20)
        })
        releaseLogout()
        await Promise.all([oldLogout, newerLogin])

        expect(JSON.parse(await readFile(resolve(temporaryDirectory, 'login.json'), 'utf8')))
          .to.deep.equal({account: 'new@example.com'})
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'new@example.com', token: 'new-token'})
      } finally {
        await rm(temporaryDirectory, {force: true, recursive: true})
      }
    })

  test
    .it('serializes lifecycle calls across clients sharing a data directory and credential service', async ctx => {
      const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'shared-login-lifecycle-race-'))
      const config = {...ctx.config, dataDir: temporaryDirectory} as Config
      const firstCommand = new Command([], config)
      const secondCommand = new Command([], config)
      const firstLogin = new Login(config, firstCommand.heroku)
      const secondLogin = new Login(config, secondCommand.heroku)
      let finishCleanup!: () => void
      let cleanupStarted!: () => void
      const cleanupStartedPromise = new Promise<void>(resolveStarted => {
        cleanupStarted = resolveStarted
      })
      const finishCleanupPromise = new Promise<void>(resolveCleanup => {
        finishCleanup = resolveCleanup
      })
      sinon.stub((firstLogin as any).delegate, 'logout').callsFake(async () => {
        cleanupStarted()
        await finishCleanupPromise
        const {deleteLoginState} = await import('../src/credential-manager-core/lib/login-state.js')
        await deleteLoginState(temporaryDirectory)
      })
      const secondDelegateLogin = sinon.stub((secondLogin as any).delegate, 'login').callsFake(async () => {
        const {writeLoginState} = await import('../src/credential-manager-core/lib/login-state.js')
        await writeLoginState(temporaryDirectory, 'new@example.com')
        return {account: 'new@example.com', token: 'new-token'}
      })
      await writeFile(resolve(temporaryDirectory, 'login.json'), '{"account":"old@example.com"}\n')

      try {
        const oldLogout = firstLogin.logout({account: 'old@example.com', token: 'old-token'})
        await cleanupStartedPromise
        const newLogin = secondLogin.login({method: 'interactive'})
        await new Promise<void>(resolveWait => {
          setImmediate(resolveWait)
        })
        expect(secondDelegateLogin.called).to.equal(false)

        finishCleanup()
        await Promise.all([oldLogout, newLogin])

        expect(JSON.parse(await readFile(resolve(temporaryDirectory, 'login.json'), 'utf8')))
          .to.deep.equal({account: 'new@example.com'})
      } finally {
        await rm(temporaryDirectory, {force: true, recursive: true})
      }
    })

  test
    .it('does not serialize lifecycle calls for unrelated data directories or credential services', async ctx => {
      const firstDirectory = await mkdtemp(resolve(tmpdir(), 'first-login-lifecycle-'))
      const secondDirectory = await mkdtemp(resolve(tmpdir(), 'second-login-lifecycle-'))
      const firstConfig = {...ctx.config, dataDir: firstDirectory} as Config
      const secondConfig = {...ctx.config, dataDir: secondDirectory} as Config
      const firstLogin = new Login(firstConfig, new Command([], firstConfig).heroku)
      const customVars = {
        ...vars.resolve(),
        apiHost: 'api.staging.heroku.com',
        apiUrl: 'https://api.staging.heroku.com',
      }
      const secondLogin = new Login(secondConfig, new Command([], secondConfig).heroku, customVars)
      let finishFirst!: () => void
      let firstStarted!: () => void
      const firstStartedPromise = new Promise<void>(resolveStarted => {
        firstStarted = resolveStarted
      })
      const finishFirstPromise = new Promise<void>(resolveFinish => {
        finishFirst = resolveFinish
      })
      sinon.stub((firstLogin as any).delegate, 'login').callsFake(async () => {
        firstStarted()
        await finishFirstPromise
        return {account: 'first@example.com', token: 'first-token'}
      })
      const secondDelegate = sinon.stub((secondLogin as any).delegate, 'login').resolves({
        account: 'second@example.com',
        token: 'second-token',
      })

      try {
        const firstAttempt = firstLogin.login({method: 'interactive'})
        await firstStartedPromise
        const secondAttempt = secondLogin.login({method: 'interactive'})
        await new Promise<void>(resolveWait => {
          setImmediate(resolveWait)
        })
        expect(secondDelegate.calledOnce).to.equal(true)

        finishFirst()
        await Promise.all([firstAttempt, secondAttempt])
      } finally {
        await Promise.all([
          rm(firstDirectory, {force: true, recursive: true}),
          rm(secondDirectory, {force: true, recursive: true}),
        ])
      }
    })

  test
    .it('pre-fills email prompt with previous account on interactive login', async ctx => {
      const capturedQuestions: any[] = []
      const promptStub = prompter.prompt as sinon.SinonStub
      promptStub.callsFake(async (questions: any[]) => {
        capturedQuestions.push(...questions)
        const answers: any = {}
        for (const q of questions) {
          if (q.name === 'email') answers.email = 'test@example.com'
          if (q.name === 'password') answers.password = 'test-password'
        }

        return answers
      })

      setCredentialManagerProvider({
        async getAuth(account) {
          return {account: account ?? 'previous@example.com', token: 'previous-token'}
        },
        async removeAuth() {},
        async saveAuth() {},
      })

      const cmd = new Command([], ctx.config)
      cmd.heroku.setAuthEntry({account: 'previous@example.com', token: 'previous-token'})

      api
        .post('/oauth/authorizations')
        .reply(200, {
          access_token: {token: 'new-token'},
          user: {email: 'test@example.com'},
        })

      await cmd.heroku.login({method: 'interactive'})
      const emailQuestion = capturedQuestions.find((q: any) => q.name === 'email')
      expect(emailQuestion).to.exist
      expect(emailQuestion.default).to.equal('previous@example.com')
    })

  test
    .it('throws a custom error message body for device_trust_required error', async ctx => {
      const cmd = new Command([], ctx.config)
      const request = nock('https://api.heroku.com')
        .post('/oauth/authorizations')
        .reply(401, {id: 'device_trust_required', message: 'original error message'})

      await chaiExpect(cmd.heroku.login({method: 'interactive'}))
        .to.be.rejectedWith('The interactive flag requires Two-Factor Authentication')
        .and.eventually.have.property('message').that.contains('Error ID: device_trust_required')
      request.done()
    })

  test
    .it('sends any other error message body through', async ctx => {
      const cmd = new Command([], ctx.config)
      const request = nock('https://api.heroku.com')
        .post('/oauth/authorizations')
        .reply(401, {id: 'unauthorized', message: 'original error message'})

      await chaiExpect(cmd.heroku.login({method: 'interactive'}))
        .to.be.rejectedWith('original error message')
        .and.eventually.have.property('message').that.contains('Error ID: unauthorized')
      request.done()
    })

  test
    .it('preserves real loopback login HTTP failure context through the package and command', async ctx => {
      const responseBody = {
        id: 'rate_limit',
        message: 'try again later',
        resource: 'authorization',
      }
      const server = createHttpServer((_request, response) => {
        response.writeHead(429, {
          'content-type': 'application/json',
          'x-request-id': 'loopback-request-id',
        })
        response.end(JSON.stringify(responseBody))
      })
      const port = await listen(server)
      const apiUrl = `http://127.0.0.1:${port}`
      const customVars = {
        apiHost: `127.0.0.1:${port}`,
        apiUrl,
        gitHost: `127.0.0.1:${port}`,
        gitPrefixes: [],
        host: apiUrl,
        httpGitHost: `127.0.0.1:${port}`,
      }

      try {
        nock.enableNetConnect(host => host === `127.0.0.1:${port}`)
        const client = new (await import('../src/api-client.js')).APIClient(ctx.config, {}, customVars)
        let failure: unknown
        try {
          await client.login({method: 'interactive'})
        } catch (error) {
          failure = error
        }

        expect(failure).to.be.instanceOf(HerokuAPIError)
        const error = failure as HerokuAPIError
        expect(error.http).to.be.instanceOf(HTTPError)
        expect(error.http.statusCode).to.equal(429)
        expect(error.http.http.statusCode).to.equal(429)
        expect(error.http.http.method).to.equal('POST')
        expect(error.http.http.url).to.equal(`${apiUrl}/oauth/authorizations`)
        expect(error.http.http.headers).to.deep.equal({})
        expect(error.http.body).to.deep.equal(responseBody)
        expect(error.http.http.body).to.deep.equal(responseBody)
        expect(error.message).to.equal('try again later\n\nError ID: rate_limit')
        expect(error.message).to.not.contain('test-password')
        for (const publicText of [error.message, error.http.message, JSON.stringify(error.http.body)]) {
          expect(publicText).to.not.contain('test-password')
          expect(publicText).to.not.contain('test@example.com')
        }
      } finally {
        nock.disableNetConnect()
        await closeServer(server)
      }
    })

  test
    .it('defaults to 30 days login', async ctx => {
      const cmd = new Command([], ctx.config)
      const request = nock('https://api.heroku.com')
        .post(
          '/oauth/authorizations',
          {description: /^Heroku CLI login from .*/, expires_in: 60 * 60 * 24 * 30, scope: ['global']},
        )
        .reply(401, {id: 'unauthorized', message: 'not authorized'})

      await chaiExpect(cmd.heroku.login({method: 'interactive'}))
        .to.be.rejectedWith('not authorized\n\nError ID: unauthorized')
      request.done()
    })

  test
    .it('allows shorter logins', async ctx => {
      const cmd = new Command([], ctx.config)
      const request = nock('https://api.heroku.com')
        .post(
          '/oauth/authorizations',
          {description: /^Heroku CLI login from .*/, expires_in: 12_345, scope: ['global']},
        )
        .reply(401, {id: 'unauthorized', message: 'not authorized'})

      await chaiExpect(cmd.heroku.login({expiresIn: 12_345, method: 'interactive'}))
        .to.be.rejectedWith('not authorized\n\nError ID: unauthorized')
      request.done()
    })

  test
    .it('does not allow logins longer than 30 days', async ctx => {
      const cmd = new Command([], ctx.config)
      const unexpectedRequest = nock('https://api.heroku.com')
        .post('/oauth/authorizations')
        .reply(500, {message: 'request should not be made'})

      await chaiExpect(cmd.heroku.login({expiresIn: 60 * 60 * 24 * 31, method: 'interactive'}))
        .to.be.rejectedWith('Cannot set an expiration longer than thirty days')
      expect(unexpectedRequest.isDone()).to.equal(false)
    })

  test
    .it('does not automatically revoke existing session when logging in', async ctx => {
      nock.cleanAll()

      api.get('/oauth/authorizations').reply(200, [])
      api.get('/oauth/authorizations/~').reply(404, {id: 'not_found', resource: 'authorization'})
      api.post('/oauth/authorizations').reply(200, {
        access_token: {token: 'new-token'},
        user: {email: 'test@example.com'},
      })

      const deleteStub = api.delete('/oauth/sessions/~').reply(200, {})

      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'test@example.com', token: 'previous-token'}
        },
        async removeAuth() {},
        async saveAuth() {},
      })

      const cmd = new Command([], ctx.config)
      await cmd.heroku.login({method: 'interactive'})

      expect(deleteStub.isDone()).to.equal(false)
    })

  for (const [alias, method] of [['i', 'interactive'], ['s', 'sso']] as const) {
    test
      .it(`normalizes the historical ${alias} login method alias`, async ctx => {
        const cmd = new Command([], ctx.config)
        const login = new Login(ctx.config, cmd.heroku)
        const {delegate} = login as any
        const loginStub = sinon.stub(delegate, 'login').resolves({account: 'test@example.com', token: 'test-token'})

        await login.login({method: alias})

        expect(loginStub.calledWithExactly({method})).to.equal(true)
      })
  }
})

describe('login with browser', () => {
  afterEach(() => {
    sinon.restore()
    restoreCredentialManagerStub()
    nock.cleanAll()
  })

  test
    .it('completes browser login through the real delegate and command adapters', async ctx => {
      const restoreEnvironment = useDeterministicLoginEnvironment()
      const saveCalls: Array<{account: string; hosts: string[]; service?: string; token: string}> = []
      const browserUrl = 'https://cli-auth.heroku.com/auth/cli/browser/browser-request?requestor=integration-test'
      const loginApi = nock('https://cli-auth.heroku.com')
        .post('/auth', body => /^Heroku CLI login from .+/.test(body.description))
        .reply(200, {
          browser_url: '/auth/cli/browser/browser-request?requestor=integration-test',
          cli_url: '/auth/cli/browser/browser-request',
          token: 'temporary-browser-token',
        })
        .get('/auth/cli/browser/browser-request')
        .matchHeader('authorization', 'Bearer temporary-browser-token')
        .reply(200, {access_token: 'browser-access-token'})
      const accountApi = nock('https://api.heroku.com')
        .get('/account')
        .matchHeader('authorization', 'Bearer browser-access-token')
        .reply(200, {email: 'browser@example.com'})

      try {
        setCredentialManagerProvider({
          async getAuth() {
            throw new Error('No auth found')
          },
          async removeAuth() {},
          async saveAuth(account, token, hosts, service) {
            saveCalls.push({
              account,
              hosts,
              service,
              token,
            })
          },
        })
        const spawnStub = stubBrowserSpawn()
        const stderrStub = sinon.stub(ux, 'stderr')
        const warnStub = sinon.stub(ux, 'warn')
        const progressStartStub = sinon.stub(ux.action, 'start')
        const progressStopStub = sinon.stub(ux.action, 'stop')
        const cmd = new Command([], ctx.config)

        await cmd.heroku.login({method: 'browser'})

        loginApi.done()
        accountApi.done()
        expect(spawnStub.calledOnce).to.equal(true)
        expect(stderrStub.calledWithExactly(`Opening browser to ${browserUrl}`)).to.equal(true)
        expect(stderrStub.calledWithExactly(ansis.greenBright(browserUrl))).to.equal(true)
        expect(warnStub.calledWithExactly('If browser does not open, visit:')).to.equal(true)
        expect(progressStartStub.args.map(call => call[0])).to.deep.equal(['heroku: Waiting for login', 'Logging in'])
        expect(progressStopStub.called).to.equal(true)
        expect(saveCalls).to.deep.equal([{
          account: 'browser@example.com',
          hosts: ['api.heroku.com', 'git.heroku.com'],
          service: 'heroku-cli',
          token: 'browser-access-token',
        }])
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({
          account: 'browser@example.com',
          token: 'browser-access-token',
        })
      } finally {
        restoreEnvironment()
      }
    })

  test
    .it('completes SSO login through the real delegate and command adapters', async ctx => {
      const restoreEnvironment = useDeterministicLoginEnvironment()
      const saveCalls: Array<{account: string; hosts: string[]; service?: string; token: string}> = []
      const ssoUrl = 'https://sso.heroku.com/saml/integration-org/init?cli=true'
      const accountApi = nock('https://api.heroku.com')
        .get('/account')
        .matchHeader('authorization', 'Bearer sso-access-token')
        .reply(200, {email: 'sso@example.com'})

      try {
        setCredentialManagerProvider({
          async getAuth() {
            throw new Error('No auth found')
          },
          async removeAuth() {},
          async saveAuth(account, token, hosts, service) {
            saveCalls.push({
              account,
              hosts,
              service,
              token,
            })
          },
        })
        const promptStub = sinon.stub(prompter, 'prompt').callsFake(async (questions: any[]) => {
          const [question] = questions
          return question.name === 'orgName'
            ? {orgName: 'integration-org'}
            : {password: 'sso-access-token'}
        })
        const spawnStub = stubBrowserSpawn()
        const stderrStub = sinon.stub(ux, 'stderr')
        sinon.stub(ux, 'warn')
        const progressStartStub = sinon.stub(ux.action, 'start')
        const progressStopStub = sinon.stub(ux.action, 'stop')
        const cmd = new Command([], ctx.config)

        await cmd.heroku.login({method: 'sso'})

        accountApi.done()
        expect(spawnStub.calledOnce).to.equal(true)
        expect(promptStub.callCount).to.equal(2)
        expect(promptStub.firstCall.args[0][0]).to.include({message: 'Organization name', name: 'orgName', type: 'input'})
        expect(promptStub.secondCall.args[0][0]).to.include({message: 'Access token', name: 'password', type: 'password'})
        expect(stderrStub.args.map(call => call[0])).to.include.members([
          'Opening browser to:',
          ansis.greenBright(ssoUrl),
          'If the browser fails to open or you are authenticating remotely, manually open the URL above.',
        ])
        expect(progressStartStub.calledOnceWithExactly('Validating token')).to.equal(true)
        expect(progressStopStub.called).to.equal(true)
        expect(saveCalls).to.deep.equal([{
          account: 'sso@example.com',
          hosts: ['api.heroku.com', 'git.heroku.com'],
          service: 'heroku-cli',
          token: 'sso-access-token',
        }])
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({
          account: 'sso@example.com',
          token: 'sso-access-token',
        })
      } finally {
        restoreEnvironment()
      }
    })

  test
    .it('keeps loginHost public and mutable and passes its current value to login', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const originalDelegate = (login as any).delegate
      const createDelegateStub = sinon.stub(login as any, 'createDelegate').callsFake((...args: unknown[]) => {
        const [loginHost] = args as [string]
        expect(loginHost).to.equal('http://127.0.0.1:54321')
        return {
          login: sinon.stub().resolves({account: 'test@example.com', token: 'test-token'}),
        }
      })

      expect(login.loginHost).to.equal(process.env.HEROKU_LOGIN_HOST || 'https://cli-auth.heroku.com')
      login.loginHost = 'http://127.0.0.1:54321'
      await login.login({method: 'b'})

      expect(createDelegateStub.calledOnce).to.equal(true)
      expect((login as any).delegate).to.not.equal(originalDelegate)
      expect((login as any).delegate.login.calledWithExactly({method: 'browser'})).to.equal(true)
    })

  test
    .it('revalidates a mutated loginHost before starting login', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      login.loginHost = 'http://example.com'

      await chaiExpect(login.login({method: 'browser'})).to.be.rejectedWith(/loginHost must be an absolute HTTPS URL/i)
    })

  test
    .it('prints fallback URL on its own line', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const warnStub = sinon.stub(ux, 'warn')
      const stderrStub = sinon.stub(ux, 'stderr')
      const url = 'https://cli-auth.heroku.com/auth/cli/browser/abc123?requestor=xyz'

      const showManualBrowserLoginUrl = (login as any).showManualBrowserLoginUrl.bind(login)
      showManualBrowserLoginUrl(url)

      expect(warnStub.calledWithExactly('If browser does not open, visit:')).to.equal(true)
      expect(warnStub.firstCall.args[0]).to.not.contain(url)
      expect(stderrStub.calledWithExactly(ansis.greenBright(url))).to.equal(true)
      sinon.assert.callOrder(warnStub, stderrStub)
    })

  test
    .it('treats ctrl-c keypress as cancel', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const errorStub = sinon.stub(ux, 'error').throws(new Error('cancelled'))

      expect(() => (login as any).getLoginMethodFromPromptKey('\u0003')).to.throw('cancelled')
      expect(errorStub.calledWithExactly('Login cancelled by user', {exit: 130})).to.equal(true)
    })

  test
    .it('treats q keypress as a historical command cancellation exit', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const errorStub = sinon.stub(ux, 'error').throws(new Error('cancelled'))

      expect(() => (login as any).getLoginMethodFromPromptKey('q')).to.throw('cancelled')
      expect(errorStub.calledWithExactly('Login cancelled by user', {exit: 2})).to.equal(true)
    })

  for (const [reason, exit] of [['quit', 2], ['interrupt', 130]] as const) {
    test
      .it(`preserves package ${reason} cancellation exit ${exit} through the command adapter`, async ctx => {
        const cmd = new Command([], ctx.config)
        const login = new Login(ctx.config, cmd.heroku)
        sinon.stub((login as any).delegate, 'login').rejects(new LoginCancelledError(reason))
        const mapped = new Error(`mapped exit ${exit}`)
        const errorStub = sinon.stub(ux, 'error').throws(mapped)

        await chaiExpect(login.login({method: 'browser'})).to.be.rejectedWith(mapped.message)

        expect(errorStub.calledOnceWithExactly('Login cancelled by user', {exit})).to.equal(true)
      })
  }

  for (const [name, key, expectedArgs] of [
    ['ctrl-c', '\u0003', ['Login cancelled by user', {exit: 130}]],
    ['q', 'q', ['Login cancelled by user', {exit: 2}]],
  ] as const) {
    test
      .it(`routes ${name} from the real prompt adapter through the key parser and restores raw mode`, async ctx => {
        const cmd = new Command([], ctx.config)
        const login = new Login(ctx.config, cmd.heroku)
        const {delegate} = login as any
        const errorStub = sinon.stub(ux, 'error').throws(new Error('cancelled'))
        const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
        const {setRawMode} = process.stdin as NodeJS.ReadStream
        Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: true})
        const setRawModeStub = sinon.stub()
        Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: setRawModeStub})
        sinon.stub(process.stdin, 'resume').returns(process.stdin)
        setImmediate(() => process.stdin.emit('data', Buffer.from(key)))

        try {
          await chaiExpect(delegate.prompt.loginMethod()).to.be.rejectedWith('cancelled')
          expect(errorStub.calledWithExactly(expectedArgs[0], expectedArgs[1])).to.equal(true)

          expect(setRawModeStub.args).to.deep.equal([[true], [false]])
        } finally {
          if (isTTY) Object.defineProperty(process.stdin, 'isTTY', isTTY)
          else delete (process.stdin as {isTTY?: boolean}).isTTY
          Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: setRawMode})
        }
      })
  }

  test
    .it('returns browser immediately from the real prompt adapter when stdin is not a TTY', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const {delegate} = login as any
      const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
      Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: false})
      const resumeStub = sinon.stub(process.stdin, 'resume').returns(process.stdin)

      try {
        expect(await delegate.prompt.loginMethod()).to.deep.equal({method: 'browser'})
        expect(resumeStub.called).to.equal(false)
      } finally {
        if (isTTY) Object.defineProperty(process.stdin, 'isTTY', isTTY)
        else delete (process.stdin as {isTTY?: boolean}).isTTY
      }
    })

  test
    .it('routes an ordinary key from the real prompt adapter to browser login and restores raw mode', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const {delegate} = login as any
      const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
      const {setRawMode} = process.stdin as NodeJS.ReadStream
      Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: true})
      const setRawModeStub = sinon.stub()
      Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: setRawModeStub})
      sinon.stub(process.stdin, 'resume').returns(process.stdin)
      setImmediate(() => process.stdin.emit('data', Buffer.from('x')))

      try {
        expect(await delegate.prompt.loginMethod()).to.deep.equal({method: 'browser'})
        expect(setRawModeStub.args).to.deep.equal([[true], [false]])
      } finally {
        if (isTTY) Object.defineProperty(process.stdin, 'isTTY', isTTY)
        else delete (process.stdin as {isTTY?: boolean}).isTTY
        Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: setRawMode})
      }
    })

  test
    .it('cancels a timed-out prompt, restores existing raw mode, and releases the lifecycle mutex', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const {delegate} = login as any
      const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
      const {isRaw, setRawMode} = process.stdin as NodeJS.ReadStream
      const dataListeners = process.stdin.listenerCount('data')
      Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: true})
      Object.defineProperty(process.stdin, 'isRaw', {configurable: true, value: true})
      const setRawModeStub = sinon.stub()
      Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: setRawModeStub})
      sinon.stub(process.stdin, 'resume').returns(process.stdin)
      const loginAttempt = login.login()

      try {
        await new Promise<void>(resolveWait => {
          setImmediate(resolveWait)
        })
        expect(process.stdin.listenerCount('data')).to.be.greaterThan(dataListeners)

        const timeoutError = new Error('Login timed out')
        const cancelLoginPrompt = (login as any).cancelLoginPrompt.bind(login)
        cancelLoginPrompt(timeoutError)

        await chaiExpect(loginAttempt).to.be.rejectedWith(timeoutError.message)
        expect(process.stdin.listenerCount('data')).to.equal(dataListeners)
        expect(setRawModeStub.args).to.deep.equal([[true], [true]])

        process.stdin.emit('data', Buffer.from('x'))
        const nextLogin = sinon.stub(delegate, 'login').resolves({account: 'next@example.com', token: 'next-token'})
        await login.login({method: 'browser'})
        expect(nextLogin.calledOnce).to.equal(true)
      } finally {
        const cancelLoginPrompt = (login as any).cancelLoginPrompt.bind(login)
        cancelLoginPrompt(new Error('test cleanup'))
        if (isTTY) Object.defineProperty(process.stdin, 'isTTY', isTTY)
        else delete (process.stdin as {isTTY?: boolean}).isTTY
        Object.defineProperty(process.stdin, 'isRaw', {configurable: true, value: isRaw})
        Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: setRawMode})
      }
    })

  test
    .it('ties the package acquisition timeout to real prompt cancellation', async ctx => {
      const clock = sinon.useFakeTimers()
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
      const {isRaw, setRawMode} = process.stdin as NodeJS.ReadStream
      const dataListeners = process.stdin.listenerCount('data')
      Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: true})
      Object.defineProperty(process.stdin, 'isRaw', {configurable: true, value: false})
      const setRawModeStub = sinon.stub()
      Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: setRawModeStub})
      sinon.stub(process.stdin, 'resume').returns(process.stdin)

      try {
        const loginAttempt = login.login()
        await clock.tickAsync(10 * 60 * 1000)

        await chaiExpect(loginAttempt).to.be.rejectedWith('Login timed out')
        expect(process.stdin.listenerCount('data')).to.equal(dataListeners)
        expect(setRawModeStub.args).to.deep.equal([[true], [false]])
      } finally {
        const cancelLoginPrompt = (login as any).cancelLoginPrompt.bind(login)
        cancelLoginPrompt(new Error('test cleanup'))
        if (isTTY) Object.defineProperty(process.stdin, 'isTTY', isTTY)
        else delete (process.stdin as {isTTY?: boolean}).isTTY
        Object.defineProperty(process.stdin, 'isRaw', {configurable: true, value: isRaw})
        Object.defineProperty(process.stdin, 'setRawMode', {configurable: true, value: setRawMode})
      }
    })

  for (const [promptName, invoke] of [
    ['email', (prompt: any) => prompt.email()],
    ['password', (prompt: any) => prompt.password()],
    ['access token', (prompt: any) => prompt.accessToken()],
    ['two-factor code', (prompt: any) => prompt.secondFactor()],
    ['organization', (prompt: any) => prompt.organization()],
  ] as const) {
    test
      .it(`aborts and disposes the ${promptName} prompt before releasing lifecycle serialization`, async ctx => {
        const cmd = new Command([], ctx.config)
        const login = new Login(ctx.config, cmd.heroku)
        const {prompt} = (login as any).delegate
        let observedSignal: AbortSignal | undefined
        let activePrompts = 0
        sinon.stub(prompter, 'prompt').callsFake(async (_questions: any[], options: {signal?: AbortSignal} = {}): Promise<never> => {
          observedSignal = options.signal
          activePrompts++
          try {
            await new Promise<never>((_resolve, reject) => {
              const abort = () => reject(options.signal?.reason)
              options.signal?.addEventListener('abort', abort, {once: true})
            })
          } finally {
            activePrompts--
          }

          throw new Error('Prompt unexpectedly completed')
        })
        sinon.stub((login as any).delegate, 'login').callsFake(async () => invoke(prompt))

        const attempt = login.login({method: 'interactive'})
        await new Promise<void>(resolveWait => {
          setImmediate(resolveWait)
        })
        expect(activePrompts).to.equal(1)
        expect(observedSignal?.aborted).to.equal(false)

        const cancelLoginPrompt = (login as any).cancelLoginPrompt.bind(login)
        cancelLoginPrompt(new Error('Login timed out'))
        await chaiExpect(attempt).to.be.rejectedWith('Login timed out')
        expect(observedSignal?.aborted).to.equal(true)
        expect(activePrompts).to.equal(0)
      })
  }

  test
    .it('observes an already-spawned browser child without waiting and warns on later failures', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses EventEmitter semantics
      const child = Object.assign(new EventEmitter(), {pid: 12_345})
      const warnStub = sinon.stub(ux, 'warn')

      expect((login as any).observeBrowserChild(child)).to.equal(undefined)

      const browserError = new Error('browser failed later')
      child.emit('error', browserError)
      child.emit('close', 1)

      expect(warnStub.calledWithExactly(browserError)).to.equal(true)
      expect(warnStub.calledWithExactly('Cannot open browser. Continue with the manual URL above.')).to.equal(true)
    })
})

describe('Login resolved vars', () => {
  afterEach(() => sinon.restore())

  test
    .it('resolves vars exactly once when no snapshot is supplied', async ctx => {
      const resolvedVars = vars.resolve()
      const resolveStub = sinon.stub(vars, 'resolve').returns(resolvedVars)

      const login = new Login(ctx.config, {} as any)
      const {delegate} = login as any

      expect(resolveStub.calledOnce).to.equal(true)
      expect(delegate.config.apiUrl).to.equal(resolvedVars.apiUrl)
      expect(delegate.config.gitHost).to.equal(resolvedVars.httpGitHost)
    })

  test
    .it('uses an APIClient vars snapshot without resolving again', async ctx => {
      const resolvedVars = vars.resolve()
      const resolveStub = sinon.stub(vars, 'resolve').throws(new Error('unexpected resolve'))

      const login = new Login(ctx.config, {} as any, resolvedVars)
      const {delegate} = login as any

      expect(resolveStub.called).to.equal(false)
      expect(delegate.config.apiUrl).to.equal(resolvedVars.apiUrl)
      expect(delegate.config.gitHost).to.equal(resolvedVars.httpGitHost)
    })
})

describe('LoginHttpError mapping', () => {
  const cases: Array<{body: unknown; expectedMessage: string; name: string}> = [
    {body: {id: 'unauthorized', message: 'structured message'}, expectedMessage: 'structured message\n\nError ID: unauthorized', name: 'structured body'},
    {body: {id: 'unauthorized'}, expectedMessage: 'Error ID: unauthorized', name: 'ID-only body'},
    {body: 'plain response', expectedMessage: 'plain response', name: 'string body'},
    {body: {}, expectedMessage: 'Login request failed with status 503', name: 'empty body'},
    {body: undefined, expectedMessage: 'Login request failed with status 503', name: 'absent body'},
  ]

  for (const testCase of cases) {
    test
      .it(`returns a contextual Error for a ${testCase.name}`, async ctx => {
        const cmd = new Command([], ctx.config)
        const login = new Login(ctx.config, cmd.heroku)
        const source = new LoginHttpError(503, testCase.body)
        Object.assign(source, {
          body: testCase.body,
          headers: {'x-request-id': 'request-id'},
          method: 'POST',
          url: 'https://api.heroku.com/oauth/authorizations',
        })

        const error = (login as any).herokuApiError(source)

        expect(error).to.be.instanceOf(Error)
        expect(error).to.be.instanceOf(HerokuAPIError)
        expect(error.message).to.equal(testCase.expectedMessage)
        expect(error.http.statusCode).to.equal(503)
        expect(error.http.body).to.deep.equal(testCase.body)
        expect(error.http.method).to.equal('POST')
        expect(error.http.url).to.equal('https://api.heroku.com/oauth/authorizations')
        expect(error.http.headers).to.deep.equal({'x-request-id': 'request-id'})
      })
  }

  test
    .it('omits untrusted transformed error URLs, credentials, queries, and opaque path segments', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const source = new LoginHttpError(503, {id: 'unavailable', message: 'failed'})
      Object.assign(source, {
        headers: {'x-request-id': 'request-id'},
        http: {
          method: 'DELETE',
          url: 'https://user:password@api.heroku.com/oauth/authorizations/private-auth-id?request=browser-request-id',
        },
        url: 'https://api.heroku.com/other/private-segment?secret=query-secret',
      })

      const error = (login as any).herokuApiError(source)

      expect(error.http.method).to.equal('DELETE')
      expect(error.http.url).to.equal(undefined)
      expect(error.http.message).to.not.contain('private-auth-id')
      expect(error.http.message).to.not.contain('private-segment')
      expect(error.http.message).to.not.contain('browser-request-id')
      expect(error.http.message).to.not.contain('user:password')
      expect(JSON.stringify(error)).to.not.contain('query-secret')
    })

  test
    .it('maps a direct LoginHttpError and leaves an arbitrary AggregateError unchanged', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const direct = new LoginHttpError(503, {id: 'unavailable', message: 'direct failure'})
      const arbitrary = new AggregateError([new Error('ordinary failure')], 'ordinary aggregate')

      const mapped = (login as any).mapLoginFailure(direct)

      expect(mapped).to.be.instanceOf(HerokuAPIError)
      expect(mapped.body).to.deep.equal({id: 'unavailable', message: 'direct failure'})
      expect((login as any).mapLoginFailure(arbitrary)).to.equal(arbitrary)
    })

  test
    .it('sanitizes generic local failures while mapping a mixed HTTP aggregate', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const source = new AggregateError([
        new Error('private local failure'),
        new LoginHttpError(503, {id: 'unavailable', message: 'remote failure'}),
      ], 'mixed failure')

      const mapped = (login as any).mapLoginFailure(source) as AggregateError

      expect(mapped).to.be.instanceOf(AggregateError)
      expect(mapped.errors[0]).to.have.property('message', 'Login operation failed')
      expect(mapped.errors[1]).to.be.instanceOf(HerokuAPIError)
      expect(JSON.stringify(mapped.errors)).to.not.contain('private local failure')
    })

  for (const property of ['cause', 'errors'] as const) {
    test
      .it(`does not replace an original failure when its ${property} getter throws`, async ctx => {
        const cmd = new Command([], ctx.config)
        const login = new Login(ctx.config, cmd.heroku)
        const original = property === 'errors'
          ? new AggregateError([], 'original aggregate failure')
          : new Error('original cause failure')
        Object.defineProperty(original, property, {
          configurable: true,
          get() {
            throw new Error(`hostile ${property} getter`)
          },
        })

        if (property === 'errors') {
          expect((login as any).mapLoginFailure(original)).to.equal(original)
        }

        const {storage} = (login as any).delegate
        setCredentialManagerProvider({
          async getAuth() {
            throw new Error('No auth found')
          },
          async removeAuth() {},
          async saveAuth() {
            throw original
          },
        })

        let caught: unknown
        try {
          await storage.saveAuth('private@example.com', 'private-token', ['api.heroku.com'], 'heroku-cli')
        } catch (error) {
          caught = error
        }

        expect(caught).to.equal(original)
      })
  }

  test
    .it('projects cyclic non-HTTP causes without exposing source messages', async ctx => {
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      const localFailure = new Error('private cyclic failure')
      Object.defineProperty(localFailure, 'cause', {configurable: true, value: localFailure})
      const source = new AggregateError([
        localFailure,
        new LoginHttpError(503, {id: 'unavailable', message: 'remote failure'}),
      ], 'mixed failure')

      const mapped = (login as any).mapLoginFailure(source) as AggregateError
      const projectedLocal = mapped.errors[0] as Error

      expect(projectedLocal.message).to.equal('Login operation failed')
      expect(projectedLocal.cause).to.equal(projectedLocal)
      expect(projectedLocal.message).to.not.contain('private cyclic failure')
    })
})

describe('LoginHttpAdapter', () => {
  const servers: Server[] = []
  const originalEnvironment = {
    HTTP_PROXY: httpCallEnvironment.HTTP_PROXY,
    http_proxy: httpCallEnvironment.http_proxy,
    HTTPS_PROXY: httpCallEnvironment.HTTPS_PROXY,
    https_proxy: httpCallEnvironment.https_proxy,
    NO_PROXY: httpCallEnvironment.NO_PROXY,
    no_proxy: httpCallEnvironment.no_proxy,
    SSL_CERT_FILE: httpCallEnvironment.SSL_CERT_FILE,
  }
  let previousProcessEnvironment: NodeJS.ProcessEnv
  let temporaryDirectory: string | undefined

  after(() => {
    if (!nock.isActive()) nock.activate()
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete httpCallEnvironment[name]
      else httpCallEnvironment[name] = value
    }

    process.env = previousProcessEnvironment

    return Promise.all(servers.splice(0).map(server => closeServer(server)))
      .then(async () => {
        if (temporaryDirectory) await rm(temporaryDirectory, {force: true, recursive: true})
        temporaryDirectory = undefined
        sinon.restore()
      })
      .finally(() => {
        if (!nock.isActive()) nock.activate()
        nock.cleanAll()
      })
  })

  beforeEach(() => {
    previousProcessEnvironment = process.env
    process.env = httpCallEnvironment
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.NO_PROXY
    delete process.env.SSL_CERT_FILE
    delete process.env.http_proxy
    delete process.env.https_proxy
    delete process.env.no_proxy
    if (!nock.isActive()) nock.activate()
    nock.cleanAll()
    nock.enableNetConnect(host => host.startsWith('127.0.0.1') || host.startsWith('localhost'))
  })

  it('normalizes successful and unsuccessful HTTP responses', async () => {
    const scope = nock('https://api.heroku.com')
      .get('/success')
      .reply(200, {ok: true}, {'X-Test': 'success'})
      .get('/failure')
      .reply(401, {id: 'unauthorized', message: 'nope'}, {'X-Test': 'failure'})
    const http = new LoginHttpAdapter()

    expect(await http.request('https://api.heroku.com/success', {method: 'GET'})).to.deep.include({
      body: {ok: true},
      ok: true,
      status: 200,
    })
    expect(await http.request('https://api.heroku.com/failure', {method: 'GET'})).to.deep.include({
      body: {id: 'unauthorized', message: 'nope'},
      ok: false,
      status: 401,
    })
    scope.done()
  })

  it('does not falsely correlate reverse-completing identical failures', async () => {
    const adapter = new LoginHttpAdapter()
    const body = {id: 'unavailable', message: 'same failure'}
    const first = nock('https://api.heroku.com')
      .delete('/oauth/sessions/~')
      .delay(25)
      .reply(503, body, {
        'set-cookie': 'session=first-secret',
        'x-request-id': 'first-request',
      })
    const second = nock('https://api.heroku.com')
      .get('/account')
      .reply(503, body, {
        'set-cookie': 'session=second-secret',
        'x-request-id': 'second-request',
      })

    const [firstResponse, secondResponse] = await Promise.all([
      adapter.request('https://api.heroku.com/oauth/sessions/~', {method: 'DELETE'}),
      adapter.request('https://api.heroku.com/account', {method: 'GET'}),
    ])
    const cmd = new Command([], new Config({root: resolve(__dirname, '../package.json')}))
    const login = new Login(cmd.config, cmd.heroku)
    Object.defineProperty(login, 'http', {value: adapter})
    const secondError = (login as any).herokuApiError(new LoginHttpError(secondResponse.status, secondResponse.body))
    const firstError = (login as any).herokuApiError(new LoginHttpError(firstResponse.status, firstResponse.body))

    expect(firstError.http.http.method).to.equal(undefined)
    expect(firstError.http.http.url).to.equal(undefined)
    expect(firstError.http.http.headers).to.deep.equal({})
    expect(firstError.http.http.headers).to.not.have.property('set-cookie')
    expect(firstError.http.body).to.deep.equal(body)
    expect(secondError.http.http.method).to.equal(undefined)
    expect(secondError.http.http.url).to.equal(undefined)
    expect(secondError.http.http.headers).to.deep.equal({})
    expect(secondError.http.http.headers).to.not.have.property('set-cookie')
    expect(secondError.http.body).to.deep.equal(body)
    expect(JSON.stringify([firstError, secondError])).to.not.contain('secret')
    first.done()
    second.done()
  })

  it('does not let a swallowed identical failure steal a surfaced failure context', async () => {
    const adapter = new LoginHttpAdapter()
    const body = {id: 'not_found', message: 'same failure', resource: 'authorization'}
    const swallowed = nock('https://api.heroku.com')
      .get('/oauth/authorizations/~')
      .reply(404, body, {'x-request-id': 'swallowed-request'})
    const surfaced = nock('https://api.heroku.com')
      .delete('/oauth/sessions/~')
      .delay(25)
      .reply(404, body, {'x-request-id': 'surfaced-request'})

    await adapter.request('https://api.heroku.com/oauth/authorizations/~', {method: 'GET'})
    const surfacedResponse = await adapter.request('https://api.heroku.com/oauth/sessions/~', {method: 'DELETE'})
    const cmd = new Command([], new Config({root: resolve(__dirname, '../package.json')}))
    const login = new Login(cmd.config, cmd.heroku)
    Object.defineProperty(login, 'http', {value: adapter})

    const error = (login as any).herokuApiError(new LoginHttpError(surfacedResponse.status, surfacedResponse.body))

    expect(error.http.http.method).to.equal(undefined)
    expect(error.http.http.url).to.equal(undefined)
    expect(error.http.http.headers).to.deep.equal({})
    swallowed.done()
    surfaced.done()
  })

  it('preserves http-call redirect behavior', async () => {
    const scope = nock('https://cli-auth.heroku.com')
      .get('/redirect')
      .reply(302, undefined, {Location: 'https://cli-auth.heroku.com/final'})
      .get('/final')
      .reply(200, {ok: true})

    const response = await new LoginHttpAdapter().request<{ok: boolean}>('https://cli-auth.heroku.com/redirect', {method: 'GET'})

    expect(response.body).to.deep.equal({ok: true})
    expect(response.status).to.equal(200)
    scope.done()
  })

  it('preserves method and body across same-origin redirects', async () => {
    const scope = nock('https://cli-auth.heroku.com')
      .post('/redirect-body', {preserved: true})
      .reply(307, undefined, {Location: '/final-body'})
      .post('/final-body', {preserved: true})
      .reply(200, {ok: true})

    const response = await new LoginHttpAdapter().request<{ok: boolean}>('https://cli-auth.heroku.com/redirect-body', {
      body: {preserved: true},
      method: 'POST',
    })

    expect(response.body).to.deep.equal({ok: true})
    expect(response.status).to.equal(200)
    scope.done()
  })

  for (const redispatch of ['redirect', 'transport retry'] as const) {
    it(`rejects a non-replayable stream before a ${redispatch} redispatch`, async () => {
      const secret = `login-${redispatch}-body-secret`
      const requests: Array<{body: string; url: string | undefined}> = []
      const server = createHttpServer((request, response) => {
        let body = ''
        request.on('data', chunk => {
          body += chunk
        })
        request.on('end', () => {
          requests.push({body, url: request.url})
          if (redispatch === 'redirect') {
            response.writeHead(307, {Location: '/final'})
            response.end()
          } else {
            request.socket.destroy()
          }
        })
      })
      servers.push(server)
      const port = await listen(server)
      nock.restore()

      const failure = await rejectionWithin(new LoginHttpAdapter().request(`http://127.0.0.1:${port}/start`, {
        body: Readable.from([secret]),
        method: 'POST',
      }))

      expect(failure.message).to.match(/non-replayable.*body/i)
      expect(failure.message).not.to.contain(secret)
      expect(requests).to.deep.equal([{body: secret, url: '/start'}])
    })
  }

  it('rejects same-origin redirects containing URL credentials before dispatch', async () => {
    const redirectUser = 'login-redirect-user'
    const redirectPassword = 'login-redirect-password'
    const browserFlowId = 'opaque-browser-flow-id'
    let targetRequested = false
    const server = createHttpServer((request, response) => {
      if (request.url?.startsWith(`/auth/cli/browser/${browserFlowId}`)) {
        targetRequested = true
        response.end('{}')
        return
      }

      response.writeHead(302, {
        Location: `http://${redirectUser}:${redirectPassword}@127.0.0.1:${(server.address() as AddressInfo).port}/auth/cli/browser/${browserFlowId}?token=login-query-secret#login-fragment-secret`,
      })
      response.end()
    })
    servers.push(server)
    const port = await listen(server)
    nock.restore()
    let failure: unknown

    try {
      await new LoginHttpAdapter().request(`http://127.0.0.1:${port}/redirect`, {method: 'GET'})
    } catch (error) {
      failure = error
    }

    expect(failure).to.be.instanceOf(Error)
    expect(targetRequested).to.equal(false)
    const diagnostic = `${(failure as Error).message}\n${JSON.stringify(failure, Object.getOwnPropertyNames(failure as object))}`
    for (const secret of [redirectUser, redirectPassword, browserFlowId, 'login-query-secret', 'login-fragment-secret']) {
      expect(diagnostic).not.to.contain(secret)
    }
  })

  it('rejects initial login request URLs containing credentials without exposing them', async () => {
    const target = 'https://login-user:login-password@cli-auth.heroku.com/auth/cli/browser/opaque-initial-id?token=login-query-secret#login-fragment-secret'
    let failure: unknown

    try {
      await new LoginHttpAdapter().request(target, {method: 'GET'})
    } catch (error) {
      failure = error
    }

    expect(failure).to.be.instanceOf(Error)
    expect((failure as Error).message).to.contain('https://cli-auth.heroku.com')
    for (const secret of ['login-user', 'login-password', 'opaque-initial-id', 'login-query-secret', 'login-fragment-secret']) {
      expect(`${(failure as Error).message}\n${JSON.stringify(failure)}`).not.to.contain(secret)
    }
  })

  it('resolves root-relative, query-relative, and same-origin redirects against the trusted current URL', async () => {
    const requests: string[] = []
    const server = createHttpServer((request, response) => {
      requests.push(`${request.headers.host}${request.url}`)
      switch (request.url) {
        case '/next': {
          response.writeHead(302, {Location: '?step=query'})
          response.end()
          break
        }

        case '/next?step=query': {
          response.writeHead(302, {Location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/final`})
          response.end()
          break
        }

        case '/start': {
          response.writeHead(302, {Location: '/next'})
          response.end()
          break
        }

        default: {
          response.setHeader('content-type', 'application/json')
          response.end('{"ok":true}')
        }
      }
    })
    servers.push(server)
    const port = await listen(server)
    nock.restore()

    const response = await new LoginHttpAdapter().request<{ok: boolean}>(`http://127.0.0.1:${port}/start`, {method: 'GET'})

    expect(response.body).to.deep.equal({ok: true})
    expect(requests).to.deep.equal([
      `127.0.0.1:${port}/start`,
      `127.0.0.1:${port}/next`,
      `127.0.0.1:${port}/next?step=query`,
      `127.0.0.1:${port}/final`,
    ])
  })

  it('rejects a loopback hostname change from 127.0.0.1 to localhost on the same port', async () => {
    let targetRequested = false
    const server = createHttpServer((request, response) => {
      if (request.url === '/target') targetRequested = true
      response.writeHead(302, {Location: `http://localhost:${(server.address() as AddressInfo).port}/target`})
      response.end()
    })
    servers.push(server)
    const port = await listen(server)
    nock.restore()

    await chaiExpect(new LoginHttpAdapter().request(`http://127.0.0.1:${port}/redirect`, {method: 'GET'}))
      .to.be.rejectedWith(/cross-origin redirect/i)

    expect(targetRequested).to.equal(false)
  })

  for (const [name, target] of [
    ['scheme', 'http://cli-auth.heroku.com/final'],
    ['host', 'https://example.com/final'],
    ['port', 'https://cli-auth.heroku.com:444/final'],
  ] as const) {
    it(`rejects a redirect that changes the ${name}`, async () => {
      const source = nock('https://cli-auth.heroku.com')
        .get(`/change-${name}`)
        .reply(302, undefined, {Location: target})

      await chaiExpect(new LoginHttpAdapter().request(`https://cli-auth.heroku.com/change-${name}`, {method: 'GET'}))
        .to.be.rejectedWith(/cross-origin redirect/i)

      source.done()
    })
  }

  it('rejects cross-origin redirects before authorization or sensitive headers reach the target', async () => {
    const requestHeaders = {
      authorization: 'Bearer login-token',
      cookie: 'session=secret',
      'heroku-two-factor-code': '123456',
    }
    let targetHeaders: Record<string, string | string[] | undefined> | undefined
    const target = createHttpServer((request, response) => {
      targetHeaders = request.headers
      response.end('{}')
    })
    const targetPort = await listen(target)
    servers.push(target)
    const source = createHttpServer((_request, response) => {
      response.writeHead(302, {Location: `http://127.0.0.1:${targetPort}/target`})
      response.end()
    })
    const sourcePort = await listen(source)
    servers.push(source)
    nock.restore()

    await chaiExpect(new LoginHttpAdapter().request(`http://127.0.0.1:${sourcePort}/redirect`, {
      headers: requestHeaders,
      method: 'GET',
    })).to.be.rejectedWith(/cross-origin redirect/i)

    expect(targetHeaders).to.equal(undefined)
  })

  it('reports only source and target origins for rejected cross-origin redirects', async () => {
    const target = createHttpServer((_request, response) => response.end('{}'))
    const targetPort = await listen(target)
    servers.push(target)
    const source = createHttpServer((_request, response) => {
      response.writeHead(302, {Location: `http://target-user:target-password@127.0.0.1:${targetPort}/target-private?target-query=secret#target-fragment`})
      response.end()
    })
    const sourcePort = await listen(source)
    servers.push(source)
    nock.restore()
    let failure: unknown

    try {
      await new LoginHttpAdapter().request(`http://127.0.0.1:${sourcePort}/source-private?source-query=secret`, {method: 'GET'})
    } catch (error) {
      failure = error
    }

    expect(failure).to.be.instanceOf(Error)
    const {message} = failure as Error
    expect(message).to.contain(`http://127.0.0.1:${sourcePort}`)
    expect(message).to.contain(`http://127.0.0.1:${targetPort}`)
    for (const secret of ['source-private', 'source-query', 'target-user', 'target-password', 'target-private', 'target-query', 'target-fragment']) {
      expect(message).not.to.contain(secret)
    }
  })

  it('enforces the http-call redirect limit', async () => {
    const server = createHttpServer((request, response) => {
      const count = Number(request.url?.slice(1) || 0)
      response.writeHead(302, {Location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${count + 1}`})
      response.end()
    })
    servers.push(server)
    const port = await listen(server)

    await chaiExpect(new LoginHttpAdapter().request(`http://127.0.0.1:${port}/0`, {method: 'GET'}))
      .to.be.rejectedWith(/Redirect loop/)
  })

  it('bypasses proxy environment for HTTP loopback without mutating it', async () => {
    const target = createHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end('{"via":"target"}')
    })
    const targetPort = await listen(target)
    servers.push(target)
    process.env.HTTP_PROXY = 'http://127.0.0.1:1'
    process.env.http_proxy = 'http://127.0.0.1:2'
    const before = {HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy}
    nock.restore()

    const response = await new LoginHttpAdapter().request<{via: string}>(`http://localhost:${targetPort}/`, {method: 'GET'})

    expect(response.body).to.deep.equal({via: 'target'})
    expect({HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy}).to.deep.equal(before)
  })

  it('keeps loopback redirects and transport retries direct when a credentialed proxy is configured', async () => {
    const requests: Array<{authorization: string | undefined; url: string | undefined}> = []
    let retryAttempts = 0
    const destination = createHttpServer((request, response) => {
      requests.push({authorization: request.headers.authorization, url: request.url})
      if (request.url === '/start') {
        response.writeHead(302, {Location: '/retry'})
        response.end()
        return
      }

      retryAttempts++
      if (retryAttempts === 1) {
        request.socket.destroy()
        return
      }

      response.setHeader('content-type', 'application/json')
      response.end('{"ok":true}')
    })
    const destinationPort = await listen(destination)
    servers.push(destination)
    const proxyRequests: Array<{authorization: string | undefined; proxyAuthorization: string | undefined}> = []
    const proxy = createHttpServer((request, response) => {
      proxyRequests.push({
        authorization: request.headers.authorization,
        proxyAuthorization: request.headers['proxy-authorization'],
      })
      response.writeHead(502)
      response.end()
    })
    const proxyPort = await listen(proxy)
    servers.push(proxy)
    process.env.HTTP_PROXY = `http://proxy-user:proxy-password@127.0.0.1:${proxyPort}`
    process.env.http_proxy = process.env.HTTP_PROXY
    nock.restore()

    const response = await new LoginHttpAdapter().request<{ok: boolean}>(`http://127.0.0.1:${destinationPort}/start`, {
      headers: {authorization: 'Bearer login-token'},
      method: 'GET',
    })

    expect(response.body).to.deep.equal({ok: true})
    expect(requests).to.deep.equal([
      {authorization: 'Bearer login-token', url: '/start'},
      {authorization: 'Bearer login-token', url: '/retry'},
      {authorization: 'Bearer login-token', url: '/retry'},
    ])
    expect(proxyRequests).to.deep.equal([])
  })

  it('honors NO_PROXY for a matching destination', async () => {
    const target = createHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end('{"direct":true}')
    })
    const targetPort = await listen(target)
    servers.push(target)
    process.env.HTTP_PROXY = 'http://127.0.0.1:1'
    process.env.NO_PROXY = 'localhost'
    nock.restore()

    const response = await new LoginHttpAdapter().request<{direct: boolean}>(`http://localhost:${targetPort}/`, {method: 'GET'})

    expect(response.body).to.deep.equal({direct: true})
  })

  it('loads a custom CA from SSL_CERT_FILE for an HTTPS proxy tunnel', async () => {
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'login-http-ca-'))
    const certificatePath = resolve(temporaryDirectory, 'ca.pem')
    await writeFile(certificatePath, TEST_CERTIFICATE)
    const target = createHttpsServer({cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY}, (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end('{"secure":true}')
    })
    const targetPort = await listen(target)
    servers.push(target)
    const proxy = createHttpServer()
    proxy.on('connect', (request, clientSocket, head) => {
      const [host, port] = request.url!.split(':')
      const upstream = createConnection(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on('error', error => clientSocket.destroy(error))
    })
    const proxyPort = await listen(proxy)
    servers.push(proxy)
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`
    process.env.SSL_CERT_FILE = certificatePath
    nock.restore()

    const response = await new LoginHttpAdapter().request<{secure: boolean}>(`https://localhost:${targetPort}/`, {method: 'GET'})

    expect(response.body).to.deep.equal({secure: true})
  })

  it('suppresses login request and response bodies and agent details in debug output', async () => {
    const server = createHttpServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.setHeader('content-type', 'application/json')
        response.setHeader('set-cookie', 'response-cookie-secret')
        response.setHeader('x-heroku-response-secret', 'response-header-secret')
        response.end('{"responseSecret":"response-body-secret"}')
      })
    })
    servers.push(server)
    const port = await listen(server)
    debug.enable('http,http:headers')
    nock.restore()

    stderr.start()
    try {
      await new LoginHttpAdapter().request(`http://127.0.0.1:${port}/debug`, {
        body: {requestSecret: 'request-body-secret'},
        headers: {
          Authorization: 'Bearer request-token',
          Cookie: 'request-cookie-secret',
          'Heroku-Two-Factor-Code': '123456',
          'X-Visible': 'ordinary-header',
        },
        method: 'POST',
      })
    } finally {
      stderr.stop()
      debug.disable()
    }

    expect(stderr.output).to.contain('ordinary-header')
    expect(stderr.output).not.to.contain('proxy:')
    for (const secret of [
      'request-body-secret',
      'request-token',
      'request-cookie-secret',
      '123456',
      'response-body-secret',
      'response-cookie-secret',
      'response-header-secret',
    ]) expect(stderr.output).not.to.contain(secret)
  })

  it('uses known route templates for login debug and response URLs', async () => {
    const browserFlowId = 'login-debug-browser-flow-id'
    const server = createHttpServer((_request, response) => {
      response.writeHead(401, {'content-type': 'application/json'})
      response.end('{"id":"unauthorized","message":"nope"}')
    })
    servers.push(server)
    const port = await listen(server)
    debug.enable('http')
    nock.restore()
    stderr.start()
    let response: any
    try {
      response = await new LoginHttpAdapter().request(
        `http://127.0.0.1:${port}/auth/cli/browser/${browserFlowId}?token=login-debug-query#login-debug-fragment`,
        {method: 'GET'},
      )
    } finally {
      stderr.stop()
      debug.disable()
    }

    expect(response.url).to.equal(`http://127.0.0.1:${port}/auth/cli/browser/:id`)
    expect(stderr.output).to.contain(`http://127.0.0.1:${port}/auth/cli/browser/:id`)
    for (const secret of [browserFlowId, 'login-debug-query', 'login-debug-fragment']) {
      expect(`${stderr.output}\n${JSON.stringify(response)}`).not.to.contain(secret)
    }
  })

  it('uses a generic path for unknown login routes in debug output', async () => {
    const opaqueRouteId = 'login-unknown-route-id'
    const server = createHttpServer((_request, response) => response.end('{}'))
    servers.push(server)
    const port = await listen(server)
    debug.enable('http')
    nock.restore()
    stderr.start()
    try {
      await new LoginHttpAdapter().request(
        `http://127.0.0.1:${port}/private/${opaqueRouteId}?token=login-unknown-query#login-unknown-fragment`,
        {method: 'GET'},
      )
    } finally {
      stderr.stop()
      debug.disable()
    }

    expect(stderr.output).to.contain(`http://127.0.0.1:${port}/[redacted]`)
    for (const secret of [opaqueRouteId, 'login-unknown-query', 'login-unknown-fragment']) {
      expect(stderr.output).not.to.contain(secret)
    }
  })

  it('fails closed when the http-call private debug hook contract is unavailable', async () => {
    const original = (HTTP.prototype as any)._debugResponse
    Object.defineProperty(HTTP.prototype, '_debugResponse', {configurable: true, value: undefined, writable: true})
    try {
      await chaiExpect(new LoginHttpAdapter().request('http://127.0.0.1:1/', {method: 'GET'}))
        .to.be.rejectedWith(/debug hook contract/i)
    } finally {
      Object.defineProperty(HTTP.prototype, '_debugResponse', {configurable: true, value: original, writable: true})
    }
  })

  it('retries a transient transport failure', async () => {
    let attempts = 0
    const server = createHttpServer((request, response) => {
      attempts++
      if (attempts === 1) {
        request.socket.destroy()
        return
      }

      response.setHeader('content-type', 'application/json')
      response.end('{"retried":true}')
    })
    const port = await listen(server)
    servers.push(server)
    nock.restore()

    const response = await new LoginHttpAdapter().request<{retried: boolean}>(`http://127.0.0.1:${port}/`, {method: 'GET'})

    expect(response.body).to.deep.equal({retried: true})
    expect(attempts).to.equal(2)
  })

  it('uses the 60-second default timeout for every request', async () => {
    const setTimeoutStub = sinon.stub(ClientRequest.prototype, 'setTimeout').returnsThis()
    const server = createHttpServer((_request, response) => response.end('{}'))
    const port = await listen(server)
    servers.push(server)
    nock.restore()

    await new LoginHttpAdapter().request(`http://127.0.0.1:${port}/`, {method: 'GET'})

    expect(setTimeoutStub.calledWith(60_000)).to.equal(true)
  })

  it('honors an already-aborted operation signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('operation canceled'))

    await chaiExpect(new LoginHttpAdapter().request('https://api.heroku.com/never', {
      method: 'GET',
      signal: controller.signal,
    })).to.be.rejectedWith('operation canceled')
  })

  it('aborts an in-flight request with the operation reason', async () => {
    const scope = nock('https://api.heroku.com').get('/slow').delay(1000).reply(200, {})
    const controller = new AbortController()
    const request = new LoginHttpAdapter().request('https://api.heroku.com/slow', {
      method: 'GET',
      signal: controller.signal,
    })
    setImmediate(() => controller.abort(new Error('operation canceled in flight')))

    await chaiExpect(request).to.be.rejectedWith('operation canceled in flight')
    scope.done()
  })

  it('aborts during retry backoff without starting a background retry', async () => {
    let attempts = 0
    const server = createHttpServer(request => {
      attempts++
      request.socket.destroy()
    })
    const port = await listen(server)
    servers.push(server)
    nock.restore()
    const controller = new AbortController()
    const request = new LoginHttpAdapter().request(`http://127.0.0.1:${port}/`, {
      method: 'GET',
      signal: controller.signal,
    })
    await once(server, 'request')
    controller.abort(new Error('operation canceled during retry'))

    await chaiExpect(request).to.be.rejectedWith('operation canceled during retry')
    await new Promise<void>(resolveWait => {
      setTimeout(resolveWait, 300)
    })
    expect(attempts).to.equal(1)
  })
})

describe('logout', () => {
  let api: nock.Scope

  beforeEach(() => {
    api = nock('https://api.heroku.com')
    api.delete('/oauth/sessions/~').reply(200, {})
  })

  afterEach(() => {
    sinon.restore()
    restoreCredentialManagerStub()
    nock.cleanAll()
  })

  test
    .it('deletes the matching authorization', async ctx => {
      const token = 'fake-token-abc'
      api.get('/oauth/authorizations').reply(200, [
        {access_token: {token}, id: 'auth-id-1'},
        {access_token: {token: 'fake-token-other'}, id: 'auth-id-2'},
      ])
      api.get('/oauth/authorizations/~').reply(200, {access_token: {token: 'fake-token-default'}})
      const deleteStub = api.delete('/oauth/authorizations/auth-id-1').reply(200, {})

      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'test@example.com', token}
        },
        async removeAuth() {},
        async saveAuth() {},
      })
      const cmd = new Command([], ctx.config)
      await cmd.heroku.logout()

      expect(deleteStub.isDone()).to.equal(true)
    })

  test
    .it('does not delete the default API key authorization', async ctx => {
      const token = 'fake-token-abc'
      api.get('/oauth/authorizations').reply(200, [
        {access_token: {token}, id: 'auth-id-1'},
      ])
      api.get('/oauth/authorizations/~').reply(200, {access_token: {token}})
      const deleteStub = api.delete('/oauth/authorizations/auth-id-1').reply(200, {})

      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'test@example.com', token}
        },
        async removeAuth() {},
        async saveAuth() {},
      })
      const cmd = new Command([], ctx.config)
      await cmd.heroku.logout()

      expect(deleteStub.isDone()).to.equal(false)
    })

  test
    .it('does not delete any authorization when no token matches', async ctx => {
      const token = 'fake-token-abc'
      api.get('/oauth/authorizations').reply(200, [
        {access_token: {token: 'fake-token-other'}, id: 'auth-id-1'},
      ])
      api.get('/oauth/authorizations/~').reply(200, {access_token: {token: 'fake-token-default'}})
      const deleteStub = api.delete('/oauth/authorizations/auth-id-1').reply(200, {})

      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'test@example.com', token}
        },
        async removeAuth() {},
        async saveAuth() {},
      })
      const cmd = new Command([], ctx.config)
      await cmd.heroku.logout()

      expect(deleteStub.isDone()).to.equal(false)
    })

  test
    .it('does not error when authorizations list is empty', async ctx => {
      const token = 'fake-token-abc'
      api.get('/oauth/authorizations').reply(200, [])
      api.get('/oauth/authorizations/~').reply(404, {id: 'not_found', resource: 'authorization'})

      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'test@example.com', token}
        },
        async removeAuth() {},
        async saveAuth() {},
      })
      const cmd = new Command([], ctx.config)
      await cmd.heroku.logout()
    })

  test
    .it('revokes a token without a cached account and skips package cleanup', async ctx => {
      const token = 'standalone-token'
      nock.cleanAll()
      const tokenApi = nock('https://api.heroku.com')
      const session = tokenApi.delete('/oauth/sessions/~').matchHeader('authorization', `Bearer ${token}`).reply(200, {})
      tokenApi.get('/oauth/authorizations').matchHeader('authorization', `Bearer ${token}`).reply(200, [])
      tokenApi.get('/oauth/authorizations/~').matchHeader('authorization', `Bearer ${token}`).reply(404, {id: 'not_found', resource: 'authorization'})
      const removeAuthStub = sinon.stub().resolves()
      setCredentialManagerProvider({
        async getAuth() {
          throw new Error('No auth found')
        },
        removeAuth: removeAuthStub,
        async saveAuth() {},
      })
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)

      await login.logout(token)

      expect(session.isDone()).to.equal(true)
      expect(removeAuthStub.called).to.equal(false)
    })

  test
    .it('keeps explicit token logout remote-only when an account is cached', async ctx => {
      const token = 'standalone-token'
      nock.cleanAll()
      const tokenApi = nock('https://api.heroku.com')
      tokenApi.delete('/oauth/sessions/~').matchHeader('authorization', `Bearer ${token}`).reply(200, {})
      tokenApi.get('/oauth/authorizations').matchHeader('authorization', `Bearer ${token}`).reply(200, [])
      tokenApi.get('/oauth/authorizations/~').matchHeader('authorization', `Bearer ${token}`).reply(404, {id: 'not_found', resource: 'authorization'})
      const removeAuthStub = sinon.stub().resolves()
      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'cached@example.com', token}
        },
        removeAuth: removeAuthStub,
        async saveAuth() {},
      })
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)

      await login.logout(token)

      expect(removeAuthStub.called).to.equal(false)
    })

  test
    .it('delegates complete entries to package cleanup exactly once', async ctx => {
      const token = 'complete-entry-token'
      api.delete('/oauth/sessions/~').matchHeader('authorization', `Bearer ${token}`).reply(200, {})
      api.get('/oauth/authorizations').matchHeader('authorization', `Bearer ${token}`).reply(200, [])
      api.get('/oauth/authorizations/~').matchHeader('authorization', `Bearer ${token}`).reply(404, {id: 'not_found', resource: 'authorization'})
      const removeAuthStub = sinon.stub().resolves()
      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'test@example.com', token}
        },
        removeAuth: removeAuthStub,
        async saveAuth() {},
      })
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)

      await login.logout({account: 'test@example.com', token})

      expect(removeAuthStub.calledOnce).to.equal(true)
    })

  test
    .it('uses the derived custom service for logout and preserves global login state', async ctx => {
      const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'custom-logout-'))
      const token = 'custom-logout-token'
      const customVars = {
        apiHost: 'api.staging.heroku.com:8443',
        apiUrl: 'https://api.staging.heroku.com:8443',
        gitHost: 'staging.heroku.com',
        gitPrefixes: [],
        host: 'https://api.staging.heroku.com:8443',
        httpGitHost: 'git.staging.heroku.com',
      }
      const removeAuthStub = sinon.stub().resolves()
      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'custom@example.com', token}
        },
        removeAuth: removeAuthStub,
        async saveAuth() {},
      })
      await writeFile(resolve(temporaryDirectory, 'login.json'), '{"account":"production@example.com"}\n')
      nock.cleanAll()
      const customApi = nock(customVars.apiUrl)
        .delete('/oauth/sessions/~')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(200, {})
        .get('/oauth/authorizations')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(200, [])
        .get('/oauth/authorizations/~')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(404, {id: 'not_found', resource: 'authorization'})

      try {
        const config = {...ctx.config, dataDir: temporaryDirectory} as Config
        const client = new (await import('../src/api-client.js')).APIClient(config, {}, customVars)

        await client.logout()

        expect(removeAuthStub.calledOnceWithExactly(
          'custom@example.com',
          ['api.staging.heroku.com:8443', 'git.staging.heroku.com'],
          'heroku-cli@api.staging.heroku.com:8443',
          token,
        )).to.equal(true)
        expect(await readFile(resolve(temporaryDirectory, 'login.json'), 'utf8'))
          .to.equal('{"account":"production@example.com"}\n')
        customApi.done()
      } finally {
        await rm(temporaryDirectory, {force: true, recursive: true})
      }
    })

  test
    .it('propagates the package-selected local cleanup failure before simultaneous remote failures', async ctx => {
      const token = 'cleanup-precedence-token'
      nock.cleanAll()
      const tokenApi = nock('https://api.heroku.com')
        .delete('/oauth/sessions/~')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(503, {id: 'unavailable', message: 'remote failure'})
        .get('/oauth/authorizations')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(503, {id: 'unavailable', message: 'remote failure'})
      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'test@example.com', token}
        },
        async removeAuth() {
          throw Object.assign(new Error('local cleanup failure'), {
            adapter: {name: 'native-secret-adapter'},
            storage: {path: '/private/credential/path'},
          })
        },
        async saveAuth() {},
      })
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      let failure: unknown

      try {
        await login.logout({account: 'test@example.com', token})
      } catch (error) {
        failure = error
      }

      expect(failure).to.be.instanceOf(Error)
      expect(failure).to.have.property('message', 'local cleanup failure')
      expect(JSON.stringify(failure)).to.not.contain('native-secret-adapter')
      expect(JSON.stringify(failure)).to.not.contain('/private/credential/path')
      tokenApi.done()
    })

  test
    .it('keeps APIClient logout rejecting when local cleanup is primary in a local and remote aggregate', async ctx => {
      const token = 'api-client-cleanup-precedence-token'
      nock.cleanAll()
      const tokenApi = nock('https://api.heroku.com')
        .delete('/oauth/sessions/~')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(503, {id: 'unavailable', message: 'remote failure'})
        .get('/oauth/authorizations')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(503, {id: 'unavailable', message: 'remote failure'})
      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'test@example.com', token}
        },
        async removeAuth() {
          throw new Error('local cleanup failure')
        },
        async saveAuth() {},
      })
      const cmd = new Command([], ctx.config)

      const failure = await rejectionWithin(cmd.heroku.logout())

      expect(failure).to.be.instanceOf(Error)
      expect(failure).to.have.property('message', 'local cleanup failure')
      tokenApi.done()
    })

  test
    .it('maps the package-selected same-status logout failure end-to-end', async ctx => {
      const token = 'same-status-token'
      nock.cleanAll()
      const tokenApi = nock('https://api.heroku.com')
        .delete('/oauth/sessions/~')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(503, {id: 'session_failure', message: 'session failed'}, {'x-request-id': 'session-request'})
        .get('/oauth/authorizations')
        .matchHeader('authorization', `Bearer ${token}`)
        .delay(25)
        .reply(503, {id: 'authorization_failure', message: 'authorization failed'}, {'x-request-id': 'authorization-request'})
      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'test@example.com', token}
        },
        async removeAuth() {},
        async saveAuth() {},
      })
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      let failure: unknown

      try {
        await login.logout({account: 'test@example.com', token})
      } catch (error) {
        failure = error
      }

      expect(failure).to.be.instanceOf(HerokuAPIError)
      const mapped = failure as HerokuAPIError
      expect(mapped.body).to.deep.equal({id: 'session_failure', message: 'session failed'})
      expect(mapped.http.http.method).to.equal(undefined)
      expect(mapped.http.http.url).to.equal(undefined)
      expect(mapped.http.http.headers).to.deep.equal({})
      tokenApi.done()
    })

  test
    .it('preserves APIClient warn-and-resolve behavior for mapped remote logout aggregates', async ctx => {
      const token = 'api-client-remote-aggregate-token'
      nock.cleanAll()
      const tokenApi = nock('https://api.heroku.com')
        .delete('/oauth/sessions/~')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(503, {id: 'session_failure', message: 'session failed'})
        .get('/oauth/authorizations')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(503, {id: 'authorization_failure', message: 'authorization failed'})
      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'test@example.com', token}
        },
        async removeAuth() {},
        async saveAuth() {},
      })
      const cmd = new Command([], ctx.config)

      stderr.start()
      try {
        await chaiExpect(cmd.heroku.logout()).to.not.be.rejected
        expect(stderr.output).to.contain('session failed')
      } finally {
        stderr.stop()
      }

      tokenApi.done()
    })

  test
    .it('does not expose an authorization ID when its DELETE fails', async ctx => {
      const token = 'authorization-delete-token'
      const authorizationId = 'private-authorization-id'
      nock.cleanAll()
      const tokenApi = nock('https://api.heroku.com')
        .delete('/oauth/sessions/~')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(200, {})
        .get('/oauth/authorizations')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(200, [{access_token: {token}, id: authorizationId}])
        .get('/oauth/authorizations/~')
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(200, {access_token: {token: 'different-default-token'}})
        .delete(`/oauth/authorizations/${authorizationId}`)
        .matchHeader('authorization', `Bearer ${token}`)
        .reply(503, {id: 'unavailable', message: 'delete failed'}, {'x-request-id': 'delete-request'})
      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'test@example.com', token}
        },
        async removeAuth() {},
        async saveAuth() {},
      })
      const cmd = new Command([], ctx.config)
      const login = new Login(ctx.config, cmd.heroku)
      let failure: unknown

      try {
        await login.logout({account: 'test@example.com', token})
      } catch (error) {
        failure = error
      }

      expect(failure).to.be.instanceOf(HerokuAPIError)
      const mapped = failure as HerokuAPIError
      expect(mapped.http.http.method).to.equal('DELETE')
      expect(mapped.http.http.url).to.equal('https://api.heroku.com/oauth/authorizations/:id')
      expect(mapped.http.http.headers).to.deep.equal({})
      for (const exposed of [mapped.message, mapped.http.message, mapped.http.http.url, JSON.stringify(mapped)]) {
        expect(exposed).to.not.contain(authorizationId)
        expect(exposed).to.not.contain(token)
      }

      tokenApi.done()
    })
})

describe('isCurrentOAuthToken', () => {
  const login = new Login(null as any, null as any)
  const match = (localToken: string, apiToken: string) =>
    (login as any).isCurrentOAuthToken(localToken, apiToken)

  it('matches identical unredacted tokens', () => {
    expect(match('fake-token-abc', 'fake-token-abc')).to.equal(true)
  })

  it('does not match different unredacted tokens', () => {
    expect(match('fake-token-abc', 'fake-token-xyz')).to.equal(false)
  })

  it('matches redacted tokens with correct prefix and suffix', () => {
    expect(match('prefixABCDEFGHIJKLMNOPQRSTUVWXYZsuffix', 'prefix**********suffix')).to.equal(true)
    expect(match('prefixABCDEFGHIJKLMNOPQRSTUVWXYZ', 'prefix**********')).to.equal(true)
  })

  it('does not match when prefix differs', () => {
    expect(match('xxxxxABCDEFGHIJKLMNOPQRSTUVWXYZsuffix', 'prefix**********suffix')).to.equal(false)
    expect(match('xxxxxABCDEFGHIJKLMNOPQRSTUVWXYZ', 'prefix**********')).to.equal(false)
  })

  it('does not match when suffix differs', () => {
    expect(match('prefixABCDEFGHIJKLMNOPQRSTUVWXYZxxxxx', 'prefix**********suffix')).to.equal(false)
    expect(match('prefixABCDEFGHIJKLMNOPQRSTUVWXYZ', 'prefix**********suffix')).to.equal(false)
  })
})
