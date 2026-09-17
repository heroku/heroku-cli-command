import type {AddressInfo} from 'node:net'

// eslint-disable-next-line n/no-extraneous-import -- installed integration dependency is intentionally local until package metadata lands
import {NativeCredentialNotFoundError} from '@heroku/heroku-credential-manager'
import {HTTPError} from '@heroku/http-call'
import {Config} from '@oclif/core/config'
import {CLIError} from '@oclif/core/errors'
import {ux} from '@oclif/core/ux'
import {expect as chaiExpect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'
import debug from 'debug'
import {expect, fancy} from 'fancy-test'
import nock from 'nock'
import * as fs from 'node:fs'
import {createServer} from 'node:http'
import {Agent} from 'node:https'
import * as os from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import * as sinon from 'sinon'
import {stderr} from 'stdout-stderr'

const SYSTEM_TMPDIR = os.tmpdir()

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

import {APIClient, HerokuAPIError, LOCALHOST_DOMAINS} from '../src/api-client.js'
import {Command as CommandBase} from '../src/command.js'
import {credentialSentrySdk} from '../src/credential-manager-core/lib/cli-command-telemetry.js'
import {writeLoginState} from '../src/credential-manager-core/lib/login-state.js'
import {
  credentialServiceForApiHost,
  isCredentialNotFoundError,
  setCredentialManagerProvider,
} from '../src/credential-manager.js'
import {ParticleboardClient} from '../src/particleboard-client.js'
import {prompter} from '../src/prompter.js'
import {RequestId, requestIdHeader} from '../src/request-id.js'
import {restoreCredentialManagerStub, stubCredentialManager} from './helpers/credential-manager-stub.js'

use(chaiAsPromised)

class Command extends CommandBase {
  async run() {}
}

const apiClientEnvKeys = [
  'HEROKU_API_KEY',
  'HEROKU_API_TOKEN',
  'HEROKU_DEBUG',
  'HEROKU_DEBUG_HEADERS',
  'HEROKU_HEADERS',
  'HEROKU_HOST',
  'HEROKU_PARTICLEBOARD_URL',
  'HTTP_PROXY',
  'http_proxy',
] as const
let apiClientEnv: Partial<Record<(typeof apiClientEnvKeys)[number], string>>
let api: nock.Scope
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const test = fancy
  .add('config', () => {
    const config = new Config({root: resolve(__dirname, '../package.json')})
    return config
  })
// const test = base.add('config', new Config({root: resolve(__dirname, '../package.json')}))

describe('api_client', () => {
  beforeEach(function () {
    nock.cleanAll()
    apiClientEnv = Object.fromEntries(apiClientEnvKeys.map(key => [key, process.env[key]]))
    for (const key of apiClientEnvKeys) delete process.env[key]
    debug.disable()
    api = nock('https://api.heroku.com')
    stubCredentialManager()
  })

  afterEach(function () {
    for (const key of apiClientEnvKeys) {
      const value = apiClientEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }

    api.done()
    restoreCredentialManagerStub()
  })

  describe('getAuthEntry', () => {
    for (const [apiHost, service] of [
      ['api.heroku.com', 'heroku-cli'],
      ['API.HEROKU.COM', 'heroku-cli'],
      ['Api.Staging.Heroku.Com:8443', 'heroku-cli@api.staging.heroku.com:8443'],
      ['[::1]:5000', 'heroku-cli@[::1]:5000'],
    ]) {
      test
        .it(`derives package-compatible credential service ${service}`, async () => {
          expect(credentialServiceForApiHost(apiHost)).to.equal(service)
        })
    }

    test
      .it('returns account and token from credential manager', async ctx => {
        stubCredentialManager('token-from-store')
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'test@example.com', token: 'token-from-store'})
      })

    test
      .it('returns cached auth entry when _auth is already set', async ctx => {
        stubCredentialManager('ignored-after-cache')
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        cmd.heroku.setAuthEntry({account: 'cached-account@example.com', token: 'cached-only'})
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({
          account: 'cached-account@example.com',
          token: 'cached-only',
        })
      })

    test
      .it('calls credential store once when getAuthEntry is invoked twice', async ctx => {
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            return {account: 'single@example.com', token: 'single-fetch-token'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        const first = await cmd.heroku.getAuthEntry()
        const second = await cmd.heroku.getAuthEntry()
        expect(first).to.deep.equal({account: 'single@example.com', token: 'single-fetch-token'})
        expect(second).to.deep.equal(first)
        expect(getCalls).to.equal(1)
      })

    test
      .it('dedupes concurrent getAuthEntry calls to credential store', async ctx => {
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            await new Promise(r => {
              setImmediate(r)
            })
            return {account: 'concurrent@example.com', token: 'concurrent-token'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        const [a, b] = await Promise.all([cmd.heroku.getAuthEntry(), cmd.heroku.getAuthEntry()])
        expect(a).to.deep.equal({account: 'concurrent@example.com', token: 'concurrent-token'})
        expect(b).to.deep.equal(a)
        expect(getCalls).to.equal(1)
      })

    test
      .it('does not call credential store twice when no credentials exist', async ctx => {
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            throw new Error('No auth found')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        expect(await cmd.heroku.getAuthEntry()).to.be.undefined
        expect(await cmd.heroku.getAuthEntry()).to.be.undefined
        expect(getCalls).to.equal(1)
      })

    test
      .it('classifies only the requested host exact netrc miss without telemetry', async ctx => {
        const originalNodeEnvironment = process.env.NODE_ENV
        process.env.NODE_ENV = 'development'
        const captureException = sinon.stub(credentialSentrySdk, 'captureException')
        const host = 'api.staging.heroku.com:8443'
        setCredentialManagerProvider({
          async getAuth() {
            throw new Error(`No auth found for ${host}`)
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const customVars = {
          apiHost: host,
          apiUrl: `https://${host}`,
          gitHost: 'staging.heroku.com',
          gitPrefixes: [],
          host: `https://${host}`,
          httpGitHost: 'git.staging.heroku.com',
        }

        try {
          const client = new APIClient(ctx.config, {}, customVars)
          expect(await client.getAuthEntry()).to.be.undefined
          expect(captureException.called).to.be.false
        } finally {
          if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV
          else process.env.NODE_ENV = originalNodeEnvironment
          captureException.restore()
        }
      })

    for (const message of [
      'No auth found for api.staging.heroku.com:8443 extra',
      'prefix No auth found for api.staging.heroku.com:8443',
      'No auth found for api.staging.heroku.com',
      'No auth found for API.STAGING.HEROKU.COM:8443',
    ]) {
      test
        .it(`does not classify netrc near miss ${JSON.stringify(message)}`, async () => {
          expect(isCredentialNotFoundError(
            new Error(message),
            'api.staging.heroku.com:8443',
          )).to.be.false
        })
    }

    test
      .it('propagates transient credential provider failures without caching absence', async ctx => {
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            throw new Error('credential backend unavailable')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)

        await chaiExpect(cmd.heroku.getAuthEntry()).to.be.rejectedWith('credential backend unavailable')
        await chaiExpect(cmd.heroku.getAuthEntry()).to.be.rejectedWith('credential backend unavailable')
        expect(getCalls).to.equal(2)
      })

    test
      .it('does not call credential store for getAuth when HEROKU_API_KEY is set', async ctx => {
        let getCalls = 0
        process.env.HEROKU_API_KEY = 'env-key'
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            return {account: 'ignored@example.com', token: 'never'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: undefined, token: 'env-key'})
        expect(getCalls).to.equal(0)
      })

    test
      .it('uses an added, rotated, and removed HEROKU_API_KEY over cached storage auth', async ctx => {
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            return {account: 'stored@example.com', token: 'stored-token'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config

        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'stored@example.com', token: 'stored-token'})
        process.env.HEROKU_API_KEY = 'first-env-key'
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: undefined, token: 'first-env-key'})
        process.env.HEROKU_API_KEY = 'rotated-env-key'
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: undefined, token: 'rotated-env-key'})
        delete process.env.HEROKU_API_KEY
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'stored@example.com', token: 'stored-token'})
        expect(getCalls).to.equal(1)
      })

    test
      .it('keeps the synchronous auth getter current as HEROKU_API_KEY is added, rotated, and removed', async ctx => {
        stubCredentialManager('stored-token')
        const cmd = new Command([], ctx.config)

        await cmd.heroku.getAuthEntry()
        expect(cmd.heroku.auth).to.equal('stored-token')
        process.env.HEROKU_API_KEY = 'first-env-key'
        expect(cmd.heroku.auth).to.equal('first-env-key')
        process.env.HEROKU_API_KEY = 'rotated-env-key'
        expect(cmd.heroku.auth).to.equal('rotated-env-key')
        delete process.env.HEROKU_API_KEY
        expect(cmd.heroku.auth).to.equal('stored-token')
      })

    test
      .it('does not let an old in-flight storage lookup overwrite a newer auth entry', async ctx => {
        let finishLookup!: (entry: {account: string; token: string}) => void
        setCredentialManagerProvider({
          getAuth: () => new Promise(resolve => {
            finishLookup = resolve
          }),
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        const oldLookup = cmd.heroku.getAuthEntry()
        await new Promise(resolve => {
          setImmediate(resolve)
        })

        cmd.heroku.setAuthEntry({account: 'new@example.com', token: 'new-token'})
        finishLookup({account: 'old@example.com', token: 'old-token'})

        expect(await oldLookup).to.deep.equal({account: 'new@example.com', token: 'new-token'})
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'new@example.com', token: 'new-token'})
        expect(cmd.heroku.auth).to.equal('new-token')
      })

    test
      .it('does not let an old in-flight storage lookup restore an explicitly cleared auth entry', async ctx => {
        let finishLookup!: (entry: {account: string; token: string}) => void
        let getCalls = 0
        setCredentialManagerProvider({
          getAuth() {
            getCalls++
            if (getCalls === 1) {
              return new Promise(resolve => {
                finishLookup = resolve
              })
            }

            return Promise.reject(new Error('No auth found'))
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        const oldLookup = cmd.heroku.getAuthEntry()
        await new Promise(resolve => {
          setImmediate(resolve)
        })

        cmd.heroku.setAuthEntry(undefined)
        finishLookup({account: 'old@example.com', token: 'old-token'})

        expect(await oldLookup).to.be.undefined
        expect(cmd.heroku.auth).to.be.undefined
        expect(await cmd.heroku.getAuthEntry()).to.be.undefined
        expect(getCalls).to.equal(2)
      })

    test
      .it('reads storage after HEROKU_API_KEY is removed', async ctx => {
        let getCalls = 0
        process.env.HEROKU_API_KEY = 'temporary-env-key'
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            return {account: 'stored@example.com', token: 'stored-token'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config

        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: undefined, token: 'temporary-env-key'})
        delete process.env.HEROKU_API_KEY
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'stored@example.com', token: 'stored-token'})
        expect(getCalls).to.equal(1)
      })

    for (const incompleteEntry of [
      {account: 'missing-token@example.com', token: undefined},
      {account: undefined, token: 'missing-account-token'},
      {account: '', token: ''},
    ]) {
      test
        .it(`does not cache incomplete storage entry ${JSON.stringify(incompleteEntry)} as auth`, async ctx => {
          let getCalls = 0
          setCredentialManagerProvider({
            async getAuth() {
              getCalls++
              return incompleteEntry
            },
            async removeAuth() {},
            async saveAuth() {},
          })
          const cmd = new Command([], ctx.config)
          cmd.config = ctx.config

          expect(await cmd.heroku.getAuthEntry()).to.be.undefined
          expect(await cmd.heroku.getAuthEntry()).to.be.undefined
          expect(cmd.heroku.auth).to.be.undefined
          expect(getCalls).to.equal(1)
        })
    }

    test
      .it('re-reads credential store after logout', async ctx => {
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            if (getCalls === 1) return {account: 'before@example.com', token: 'before-logout'}
            return {account: 'after@example.com', token: 'after-logout'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        api.delete('/oauth/sessions/~').reply(200, {})
        api.get('/oauth/authorizations').reply(200, [])
        api.get('/oauth/authorizations/~').reply(404, {id: 'not_found', resource: 'authorization'})

        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({
          account: 'before@example.com',
          token: 'before-logout',
        })
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({
          account: 'before@example.com',
          token: 'before-logout',
        })
        await cmd.heroku.logout()
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({
          account: 'after@example.com',
          token: 'after-logout',
        })
        expect(getCalls).to.equal(2)
      })

    test
      .it('401 unauthorized retries request with token set after login', async ctx => {
        stubCredentialManager('stale-token')
        api.get('/account').reply(401)
        api.get('/account').reply(200, {ok: true})

        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        sinon.stub(cmd.heroku, 'login').callsFake(async () => {
          cmd.heroku.setAuthEntry({account: undefined, token: 'fresh-token'})
          return undefined as any
        })

        const {body} = await cmd.heroku.get('/account')
        expect(body).to.deep.equal({ok: true})
        expect((cmd.heroku.login as sinon.SinonStub).calledOnce).to.be.true;
        (cmd.heroku.login as sinon.SinonStub).restore()
      })

    test
      .it('keeps the previous in-memory auth when login fails', async ctx => {
        const cmd = new Command([], ctx.config)
        cmd.heroku.setAuthEntry({account: 'previous@example.com', token: 'previous-token'})
        sinon.stub((cmd.heroku as any)._login, 'login').rejects(new Error('login failed'))

        await chaiExpect(cmd.heroku.login({method: 'interactive'})).to.be.rejectedWith('login failed')
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({
          account: 'previous@example.com',
          token: 'previous-token',
        })
      })
  })

  describe('login state file integration', () => {
    let tmpDir: string
    let platformStub: sinon.SinonStub

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(join(SYSTEM_TMPDIR, 'heroku-api-client-'))
      platformStub = sinon.stub(process, 'platform').value('darwin')
    })

    afterEach(() => {
      fs.rmSync(tmpDir, {force: true, recursive: true})
      platformStub.restore()
    })

    test
      .it('passes cached account from login.json to credential store', async ctx => {
        let receivedAccount: string | undefined
        setCredentialManagerProvider({
          async getAuth(account) {
            receivedAccount = account
            return {account: account ?? 'fallback@example.com', token: 'cached-token'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        await writeLoginState(tmpDir, 'cached@example.com')
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config
        await cmd.heroku.getAuthEntry()
        expect(receivedAccount).to.equal('cached@example.com')
      })

    test
      .it('uses canonical account selection and service only for production', async ctx => {
        const calls: Array<{account?: string; host: string; service?: string}> = []
        setCredentialManagerProvider({
          async getAuth(account, host, service) {
            calls.push({account, host, service})
            return {account: account ?? 'fallback@example.com', token: 'token'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        await writeLoginState(tmpDir, 'production@example.com')

        const productionVars = {
          apiHost: 'api.heroku.com',
          apiUrl: 'https://api.heroku.com',
          gitHost: 'heroku.com',
          gitPrefixes: [],
          host: 'heroku.com',
          httpGitHost: 'git.heroku.com',
        }
        const customVars = {
          apiHost: 'api.staging.heroku.com:8443',
          apiUrl: 'https://api.staging.heroku.com:8443',
          gitHost: 'staging.heroku.com',
          gitPrefixes: [],
          host: 'https://api.staging.heroku.com:8443',
          httpGitHost: 'git.staging.heroku.com',
        }
        const config = {...ctx.config, dataDir: tmpDir} as Config

        await new APIClient(config, {}, productionVars).getAuthEntry()
        await new APIClient(config, {}, customVars).getAuthEntry()

        expect(calls).to.deep.equal([
          {account: 'production@example.com', host: 'api.heroku.com', service: 'heroku-cli'},
          {account: undefined, host: 'api.staging.heroku.com:8443', service: 'heroku-cli@api.staging.heroku.com:8443'},
        ])
        expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.true
      })

    test
      .it('deletes login.json on logout', async ctx => {
        setCredentialManagerProvider({
          async getAuth() {
            return {account: 'logout-int@example.com', token: 'logout-int-token'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        await writeLoginState(tmpDir, 'logout-int@example.com')
        api.delete('/oauth/sessions/~').reply(200, {})
        api.get('/oauth/authorizations').reply(200, [])
        api.get('/oauth/authorizations/~').reply(404, {id: 'not_found', resource: 'authorization'})
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config
        await cmd.heroku.logout()
        expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.false
      })

    test
      .it('preserves stored credentials when logging out an environment token', async ctx => {
        const removeAuthStub = sinon.stub().resolves()
        setCredentialManagerProvider({
          async getAuth() {
            return {account: 'stored@example.com', token: 'stored-token'}
          },
          removeAuth: removeAuthStub,
          async saveAuth() {},
        })
        await writeLoginState(tmpDir, 'stored@example.com')
        process.env.HEROKU_API_KEY = 'environment-token'
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config
        const logoutStub = sinon.stub((cmd.heroku as any)._login, 'logout').resolves()

        await cmd.heroku.logout()

        expect(logoutStub.calledOnceWithExactly()).to.be.true
        expect(removeAuthStub.called).to.be.false
        expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.true

        delete process.env.HEROKU_API_KEY
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({
          account: 'stored@example.com',
          token: 'stored-token',
        })
        expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.true
      })

    test
      .it('clears stale login.json when credential store has no matching account', async ctx => {
        setCredentialManagerProvider({
          async getAuth() {
            throw new Error('No auth found')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        await writeLoginState(tmpDir, 'stale@example.com')
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config
        await cmd.heroku.getAuthEntry()
        expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.false
      })

    test
      .it('preserves login.json when the credential backend fails transiently', async ctx => {
        setCredentialManagerProvider({
          async getAuth() {
            throw new Error('keychain temporarily unavailable')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        await writeLoginState(tmpDir, 'selected@example.com')
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config

        await chaiExpect(cmd.heroku.getAuthEntry()).to.be.rejectedWith('keychain temporarily unavailable')
        expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.true
      })

    test
      .it('clears login.json for a typed confirmed credential miss', async ctx => {
        setCredentialManagerProvider({
          async getAuth() {
            throw new NativeCredentialNotFoundError('not present')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        await writeLoginState(tmpDir, 'stale@example.com')
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config

        expect(await cmd.heroku.getAuthEntry()).to.be.undefined
        expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.false
      })
  })

  describe('setAuthEntry', () => {
    test
      .it('updates auth getter and subsequent getAuthEntry without calling credential store', async ctx => {
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            return {account: 'ignored@example.com', token: 'ignored'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        cmd.heroku.setAuthEntry({account: 'set@example.com', token: 'set-token'})
        expect(cmd.heroku.auth).to.equal('set-token')
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'set@example.com', token: 'set-token'})
        expect(getCalls).to.equal(0)
      })

    test
      .it('clears token and account when called with undefined', async ctx => {
        setCredentialManagerProvider({
          async getAuth() {
            throw new Error('No auth found')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        cmd.heroku.setAuthEntry({account: 'gone@example.com', token: 'gone-token'})
        cmd.heroku.setAuthEntry(undefined)
        expect(cmd.heroku.auth).to.be.undefined
        expect(await cmd.heroku.getAuthEntry()).to.be.undefined
      })

    test
      .it('after clear, getAuthEntry reads credential store again', async ctx => {
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            return {account: 'second@example.com', token: `call-${getCalls}`}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'second@example.com', token: 'call-1'})
        cmd.heroku.setAuthEntry(undefined)
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'second@example.com', token: 'call-2'})
        expect(getCalls).to.equal(2)
      })
  })

  describe('logout', () => {
    const removeAuthCalls: Array<{
      account: string | undefined
      expectedToken?: string
      hosts: string[]
      service?: string
    }> = []

    beforeEach(() => {
      removeAuthCalls.length = 0
      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'logout@example.com', token: 'logout-test-token'}
        },
        async removeAuth(account: string | undefined, hosts: string[], service?: string, expectedToken?: string) {
          removeAuthCalls.push({
            account,
            expectedToken,
            hosts,
            service,
          })
        },
        async saveAuth() {},
      })
    })

    afterEach(() => {
      delete process.env.HEROKU_API_KEY
    })

    test
      .it('lets package login own persistent cleanup for a complete auth entry', async ctx => {
        api.delete('/oauth/sessions/~').reply(200, {})
        api.get('/oauth/authorizations').reply(200, [])
        api.get('/oauth/authorizations/~').reply(404, {id: 'not_found', resource: 'authorization'})
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        await cmd.heroku.logout()
        expect(removeAuthCalls).to.have.length(1)
        expect(removeAuthCalls[0].account).to.equal('logout@example.com')
        expect(removeAuthCalls[0].hosts).to.deep.equal(['api.heroku.com', 'git.heroku.com'])
        expect(removeAuthCalls[0].service).to.equal('heroku-cli')
        expect(removeAuthCalls[0].expectedToken).to.equal('logout-test-token')
        expect(cmd.heroku.auth).to.be.undefined
      })

    test
      .it('does not duplicate package cleanup after a complete-entry logout', async ctx => {
        nock.cleanAll()
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        const logoutStub = sinon.stub((cmd.heroku as any)._login, 'logout').resolves()

        await cmd.heroku.logout()

        expect(logoutStub.calledOnceWithExactly()).to.be.true
        expect(removeAuthCalls).to.have.length(0)
        expect(cmd.heroku.auth).to.be.undefined
      })

    test
      .it('passes HEROKU_API_KEY exactly to remote-only logout without persistent cleanup', async ctx => {
        process.env.HEROKU_API_KEY = 'env-api-key'
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        const logoutStub = sinon.stub((cmd.heroku as any)._login, 'logout').resolves()

        await cmd.heroku.logout()

        expect(logoutStub.calledOnceWithExactly()).to.be.true
        expect(removeAuthCalls).to.have.length(0)
      })

    test
      .it('passes a public auth-setter token to remote-only logout without persistent cleanup', async ctx => {
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        cmd.heroku.auth = 'setter-token'
        const logoutStub = sinon.stub((cmd.heroku as any)._login, 'logout').resolves()

        await cmd.heroku.logout()

        expect(logoutStub.calledOnceWithExactly()).to.be.true
        expect(removeAuthCalls).to.have.length(0)
        expect(cmd.heroku.auth).to.be.undefined
      })

    test
      .it('does no remote or persistent cleanup when no credential exists', async ctx => {
        const removeAuthStub = sinon.stub().resolves()
        setCredentialManagerProvider({
          async getAuth() {
            throw new Error('No auth found')
          },
          removeAuth: removeAuthStub,
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        const logoutStub = sinon.stub((cmd.heroku as any)._login, 'logout').resolves()

        await cmd.heroku.logout()

        expect(logoutStub.calledOnceWithExactly()).to.be.true
        expect(removeAuthStub.called).to.be.false
        expect(cmd.heroku.auth).to.be.undefined
      })

    for (const incompleteEntry of [
      {account: 'missing-token@example.com', token: undefined},
      {account: undefined, token: 'provider-token-without-account'},
    ]) {
      test
        .it(`does no broad cleanup for incomplete provider data ${JSON.stringify(incompleteEntry)}`, async ctx => {
          const removeAuthStub = sinon.stub().resolves()
          setCredentialManagerProvider({
            async getAuth() {
              return incompleteEntry
            },
            removeAuth: removeAuthStub,
            async saveAuth() {},
          })
          const cmd = new Command([], ctx.config)
          cmd.config = ctx.config
          const logoutStub = sinon.stub((cmd.heroku as any)._login, 'logout').resolves()

          await cmd.heroku.logout()

          expect(logoutStub.calledOnceWithExactly()).to.be.true
          expect(removeAuthStub.called).to.be.false
          expect(cmd.heroku.auth).to.be.undefined
        })
    }

    test
      .it('resets in-memory auth when credential resolution fails', async ctx => {
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        cmd.heroku.setAuthEntry({account: 'cached@example.com', token: 'cached-token'})
        sinon.stub(cmd.heroku, 'getAuthEntry').rejects(new Error('credential resolution failed'))

        await chaiExpect(cmd.heroku.logout()).to.be.rejectedWith('credential resolution failed')
        expect(cmd.heroku.auth).to.be.undefined
      })

    test
      .it('preserves historical warn-and-resolve behavior for remote CLIError logout failures', async ctx => {
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        cmd.heroku.setAuthEntry({account: 'cached@example.com', token: 'cached-token'})
        sinon.stub((cmd.heroku as any)._login, 'logout').rejects(new CLIError('logout CLI failure'))

        stderr.start()
        try {
          await chaiExpect(cmd.heroku.logout()).to.not.be.rejected
          expect(stderr.output).to.contain('logout CLI failure')
          expect(cmd.heroku.auth).to.be.undefined
        } finally {
          stderr.stop()
        }
      })

    test
      .it('does not let an older in-flight logout erase a newer public auth setter', async ctx => {
        let finishLogout!: () => void
        const cmd = new Command([], ctx.config)
        cmd.heroku.setAuthEntry({account: 'old@example.com', token: 'old-token'})
        sinon.stub((cmd.heroku as any)._login, 'logout').returns(new Promise<void>(resolve => {
          finishLogout = resolve
        }))

        const logout = cmd.heroku.logout()
        await new Promise(resolve => {
          setImmediate(resolve)
        })
        cmd.heroku.auth = 'new-token'
        finishLogout()
        await logout

        expect(cmd.heroku.auth).to.equal('new-token')
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: undefined, token: 'new-token'})
      })

    test
      .it('does not let an older in-flight logout erase a subsequently completed login', async ctx => {
        let finishLogout!: () => void
        const cmd = new Command([], ctx.config)
        cmd.heroku.setAuthEntry({account: 'old@example.com', token: 'old-token'})
        sinon.stub((cmd.heroku as any)._login, 'logout').returns(new Promise<void>(resolve => {
          finishLogout = resolve
        }))

        const logout = cmd.heroku.logout()
        await new Promise(resolve => {
          setImmediate(resolve)
        })
        cmd.heroku.setAuthEntry({account: 'new@example.com', token: 'login-token'})
        finishLogout()
        await logout

        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'new@example.com', token: 'login-token'})
      })

    test
      .it('propagates non-CLI logout failures and resets in-memory auth', async ctx => {
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        sinon.stub((cmd.heroku as any)._login, 'logout').rejects(new Error('credential cleanup failed'))

        await chaiExpect(cmd.heroku.logout()).to.be.rejectedWith('credential cleanup failed')
        expect(cmd.heroku.auth).to.be.undefined
      })
  })

  test
    .it('exports the historical localhost domain constants', () => {
      expect(LOCALHOST_DOMAINS).to.deep.equal(['localhost', '127.0.0.1'])
    })

  test
    .it('makes an HTTP request', async ctx => {
      api = nock('https://api.heroku.com', {
        reqheaders: {authorization: 'Bearer mypass'},
      })
      api.get('/apps').reply(200, [{name: 'myapp'}])

      const cmd = new Command([], ctx.config)
      const {body} = await cmd.heroku.get('/apps')
      expect(body).to.deep.equal([{name: 'myapp'}])
    })

  test
    .it('can override authorization header', async ctx => {
      api = nock('https://api.heroku.com', {
        reqheaders: {authorization: 'Bearer myotherpass'},
      })
      api.get('/apps').reply(200, [{name: 'myapp'}])

      const cmd = new Command([], ctx.config)
      const {body} = await cmd.heroku.get('/apps', {headers: {Authorization: 'Bearer myotherpass'}})
      expect(body).to.deep.equal([{name: 'myapp'}])
    })

  test
    .it('preserves caller authorization across a successful 2fa retry', async ctx => {
      const scope = nock('https://api.heroku.com', {reqheaders: {authorization: 'Bearer caller-token'}})
        .get('/caller-two-factor')
        .reply(403, {id: 'two_factor'})
        .get('/caller-two-factor')
        .matchHeader('heroku-two-factor-code', '123456')
        .reply(200, [])
      const options = {headers: {Authorization: 'Bearer caller-token'}}
      const client = new APIClient(ctx.config)
      const login = sinon.stub(client, 'login').rejects(new Error('login invoked'))
      sinon.stub(client, 'twoFactorPrompt').resolves('123456')

      await client.get('/caller-two-factor', options)

      expect(login.called).to.be.false
      expect(options).to.deep.equal({headers: {Authorization: 'Bearer caller-token'}})
      scope.done()
    })

  describe('with HEROKU_HEADERS', () => {
    let headersApi: nock.Scope

    beforeEach(() => {
      headersApi = nock('https://api.heroku.com')
    })

    afterEach(() => {
      headersApi.done()
    })

    test
      .it('makes an HTTP request with HEROKU_HEADERS', async ctx => {
        process.env.HEROKU_HEADERS = '{"x-foo": "bar"}'
        headersApi = nock('https://api.heroku.com', {
          reqheaders: {'x-foo': 'bar'},
        })
        headersApi.get('/apps').reply(200, [{name: 'myapp'}])

        const cmd = new Command([], ctx.config)
        const {body} = await cmd.heroku.get('/apps')
        expect(body).to.deep.equal([{name: 'myapp'}])
      })

    test
      .it('does not inherit HEROKU_HEADERS or sensitive caller headers on an external request', async ctx => {
        process.env.HEROKU_HEADERS = JSON.stringify({
          Cookie: 'heroku-session=secret',
          'Proxy-Authorization': 'Basic proxy-secret',
          'X-Addon-Sso': 'addon-secret',
          'X-Heroku-Environment-Secret': 'environment-secret',
        })
        const external = nock('https://example.com', {
          badheaders: [
            'authorization',
            'cookie',
            'heroku-two-factor-code',
            'proxy-authorization',
            requestIdHeader,
            'x-addon-sso',
            'x-heroku-environment-secret',
          ],
          reqheaders: {'x-current-call': 'preserved'},
        })
          .get('/apps')
          .reply(200, [])
        const client = new APIClient(ctx.config)

        await client.get('https://example.com/apps', {
          headers: {
            Authorization: 'Bearer caller-secret',
            Cookie: 'caller-session=secret',
            'Heroku-Two-Factor-Code': '123456',
            'Proxy-Authorization': 'Basic caller-proxy-secret',
            'X-Addon-Sso': 'caller-addon-secret',
            'X-Current-Call': 'preserved',
          },
        })

        external.done()
      })
  })

  describe('with HEROKU_API_KEY', () => {
    test
      .it('errors out before attempting a login when HEROKU_API_KEY is set, but invalid', async ctx => {
        process.env.HEROKU_API_KEY = 'blah'
        api = nock('https://api.heroku.com', {
          reqheaders: {Authorization: 'Bearer blah'},
        })
        api.get('/account').reply(401)

        const cmd = new Command([], ctx.config)
        try {
          await cmd.heroku.get('/account')
        } catch (error) {
          if (error instanceof Error) {
            expect(error.message).to.equal('The token provided to HEROKU_API_KEY is invalid. Please double-check that you have the correct token, or run `heroku login` without HEROKU_API_KEY set.')
          } else {
            throw new TypeError('Unexpected error')
          }
        }
      })
  })

  describe('with HEROKU_HOST', () => {
    test
      .it('rejects invalid HEROKU_HOST and uses default API', async ctx => {
        process.env.HEROKU_HOST = 'http://bogus-server.com'
        api = nock('https://api.heroku.com') // Should fallback to default
        api.get('/apps').reply(200, [{name: 'myapp'}])

        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/apps')
      })

    test
      .it('makes an HTTP request with HEROKU_HOST', async ctx => {
        const localHostURI = 'http://localhost:5000'
        process.env.HEROKU_HOST = localHostURI
        api = nock(localHostURI)
        api.get('/apps').reply(200, [{name: 'myapp'}])

        const cmd = new Command([], ctx.config)
        const {body} = await cmd.heroku.get('/apps')
        expect(body).to.deep.equal([{name: 'myapp'}])
      })

    test
      .it('makes a relative HTTP request with an IPv6 loopback HEROKU_HOST', async function (ctx) {
        let authorization: string | undefined
        const proxyEnv = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'].map(key => [key, process.env[key]]))
        for (const key of Object.keys(proxyEnv)) delete process.env[key]
        const server = createServer((request, response) => {
          authorization = request.headers.authorization
          response.setHeader('content-type', 'application/json')
          response.end('[{"name":"myapp"}]')
        })

        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '::1', resolve)
          })
        } catch (error) {
          server.close()
          for (const [key, value] of Object.entries(proxyEnv)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }

          if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL' || (error as NodeJS.ErrnoException).code === 'EAFNOSUPPORT') {
            this.skip()
            return
          }

          throw error
        }

        const {port} = server.address() as AddressInfo
        process.env.HEROKU_HOST = `http://[::1]:${port}`
        nock.restore()
        try {
          const cmd = new Command([], ctx.config)
          const {body} = await cmd.heroku.get('/apps')
          expect(body).to.deep.equal([{name: 'myapp'}])
          expect(authorization).to.equal('Bearer mypass')
        } finally {
          await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve())
          })
          for (const [key, value] of Object.entries(proxyEnv)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }

          nock.activate()
        }
      })
  })

  describe('authorization target policy', () => {
    test
      .it('ignores ClientRequestArgs auth instead of injecting Basic authorization into an external request', async ctx => {
        const external = nock('https://example.com', {badheaders: ['authorization']})
          .get('/basic-auth')
          .reply(200, [])
        const options = {auth: 'attacker:secret'}
        const client = new APIClient(ctx.config)

        await client.get('https://example.com/basic-auth', options)

        expect(options).to.deep.equal({auth: 'attacker:secret'})
        external.done()
      })

    test
      .it('rejects socketPath before generated authorization can reach another destination', async ctx => {
        const socketDirectory = fs.mkdtempSync(join(SYSTEM_TMPDIR, 'heroku-api-client-socket-'))
        const socketPath = join(socketDirectory, 'api.sock')
        let receivedAuthorization: string | undefined
        const server = createServer((request, response) => {
          receivedAuthorization = request.headers.authorization
          response.setHeader('content-type', 'application/json')
          response.end('[]')
        })

        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(socketPath, resolve)
        })

        nock.restore()
        try {
          const client = new APIClient(ctx.config)
          await chaiExpect(client.get('http://localhost/socket-path', {socketPath}))
            .to.be.rejectedWith(/socketPath/i)
          expect(receivedAuthorization).to.be.undefined
        } finally {
          await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve())
          })
          fs.rmSync(socketDirectory, {force: true, recursive: true})
          nock.activate()
        }
      })

    for (const [option, value] of [
      ['createConnection', () => {
        throw new Error('custom connection invoked')
      }],
      ['lookup', () => {
        throw new Error('custom lookup invoked')
      }],
      ['agent', {
        addRequest() {
          throw new Error('custom agent invoked')
        },
      }],
    ] as const) {
      test
        .it(`rejects a caller-provided ${option} before attaching generated authorization`, async ctx => {
          const client = new APIClient(ctx.config)

          await chaiExpect(client.get('/custom-routing', {[option]: value}))
            .to.be.rejectedWith(new RegExp(option, 'i'))
        })
    }

    test
      .it('builds external headers only from normalized current-call headers', async ctx => {
        process.env.HEROKU_HEADERS = JSON.stringify({'X-Environment-Default': 'environment-secret'})
        const external = nock('https://example.com', {
          badheaders: [
            'user-agent',
            'x-delete-me',
            'x-environment-default',
            'x-runtime-default',
          ],
          reqheaders: {
            accept: 'current-call-accept',
            'x-current-call': 'preserved',
            'x-mixed-case': 'normalized',
          },
        })
          .get('/headers')
          .reply(200, [])
        const options: APIClient.Options = {
          headers: {
            Accept: 'current-call-accept',
            'X-Current-Call': 'preserved',
            'x-delete-me': undefined,
            'X-MiXeD-CaSe': 'normalized',
          },
        }
        const client = new APIClient(ctx.config)
        client.defaults.headers = {
          ...client.defaults.headers,
          'X-DELETE-ME': 'uppercase-inherited',
          'x-delete-me': 'lowercase-inherited',
          'X-Runtime-Default': 'runtime-secret',
        } as NonNullable<typeof client.defaults.headers>

        await client.get('https://example.com/headers', options)

        expect(options).to.deep.equal({
          headers: {
            Accept: 'current-call-accept',
            'X-Current-Call': 'preserved',
            'x-delete-me': undefined,
            'X-MiXeD-CaSe': 'normalized',
          },
        })
        external.done()
      })

    test
      .it('rejects mutable routing defaults instead of authorizing their destination', async ctx => {
        const client = new APIClient(ctx.config)
        client.defaults.hostname = 'example.com'

        await chaiExpect(client.get('/mutable-default-route'))
          .to.be.rejectedWith(/default.*hostname/i)
      })

    test
      .it('supports the Data API defaults.host routing pattern with generated authorization', async ctx => {
        const dataApi = nock('https://api.data.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
          .get('/apps')
          .reply(200, [{name: 'myapp'}])
        const client = new APIClient(ctx.config)
        client.defaults.host = 'api.data.heroku.com'

        const {body} = await client.get('/apps')

        expect(body).to.deep.equal([{name: 'myapp'}])
        dataApi.done()
      })

    test
      .it('does not authorize an untrusted defaults.host destination', async ctx => {
        const external = nock('https://example.com', {badheaders: ['authorization']})
          .get('/apps')
          .reply(200, [])
        const client = new APIClient(ctx.config)
        client.defaults.host = 'example.com'

        await client.get('/apps')

        external.done()
      })

    test
      .it('does not login or retry with authorization after an untrusted defaults.host 401', async ctx => {
        const external = nock('https://example.com', {badheaders: ['authorization']})
          .get('/account')
          .reply(401, {id: 'unauthorized', message: 'nope'})
        const client = new APIClient(ctx.config)
        client.defaults.host = 'example.com'
        const login = sinon.stub(client, 'login').rejects(new Error('login invoked'))

        await chaiExpect(client.get('/account')).to.be.rejectedWith(HerokuAPIError, 'nope')

        expect(login.called).to.be.false
        external.done()
      })

    test
      .it('rejects unsafe defaults added by an HTTP subclass at dispatch', async ctx => {
        const client = new APIClient(ctx.config)
        class UnsafeSubclass<T> extends client.http<T> {}
        UnsafeSubclass.defaults = {
          ...client.defaults,
          createConnection() {
            throw new Error('must not be called')
          },
        }

        await chaiExpect(UnsafeSubclass.get('/subclass-default'))
          .to.be.rejectedWith(/default.*createConnection/i)
      })

    for (const [option, value] of [
      ['agent', false],
      ['host', 'example.com'],
      ['hostname', 'example.com'],
      ['port', 81],
      ['protocol', 'http:'],
      ['socketPath', '/tmp/unsafe.sock'],
    ] as const) {
      test
        .it(`rejects post-construction ${option} mutation at final dispatch`, async ctx => {
          const client = new APIClient(ctx.config)
          const HTTPClient = client.http
          const request = new HTTPClient('/post-construction')
          Object.assign(request.options, {[option]: value})

          await chaiExpect(request._request()).to.be.rejectedWith(new RegExp(option, 'i'))
        })
    }

    test
      .it('bypasses proxy environment for HTTP loopback without mutating it', async ctx => {
        const server = createServer((_request, response) => {
          response.setHeader('content-type', 'application/json')
          response.end('[]')
        })
        await new Promise<void>((resolveListen, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolveListen)
        })
        const {port} = server.address() as AddressInfo
        process.env.HTTP_PROXY = 'http://127.0.0.1:1'
        process.env.http_proxy = 'http://127.0.0.1:2'
        const before = {HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy}
        nock.restore()

        try {
          const client = new APIClient(ctx.config)
          const {body} = await client.get(`http://127.0.0.1:${port}/direct`)

          expect(body).to.deep.equal([])
          expect({HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy}).to.deep.equal(before)
        } finally {
          await new Promise<void>((resolveClose, reject) => {
            server.close(error => error ? reject(error) : resolveClose())
          })
          nock.activate()
        }
      })

    test
      .it('enforces target and header isolation for direct HTTP instances', async ctx => {
        process.env.HEROKU_HEADERS = JSON.stringify({'X-Inherited-Secret': 'environment-secret'})
        const external = nock('https://example.com', {
          badheaders: ['authorization', requestIdHeader, 'user-agent', 'x-inherited-secret'],
          reqheaders: {'x-current-call': 'preserved'},
        })
          .get('/direct')
          .reply(200, [])
        const client = new APIClient(ctx.config)
        const HTTPClient = client.http
        const request = new HTTPClient('https://example.com/direct', {
          headers: {
            Authorization: 'Bearer caller-secret',
            'X-Current-Call': 'preserved',
          },
        })

        await request._request()

        external.done()
      })

    test
      .it('adds generated authorization once for direct trusted HTTP instances', async ctx => {
        api = nock('https://api.heroku.com', {reqheaders: {authorization: 'Bearer mypass'}})
          .get('/direct-trusted')
          .reply(200, [])
        const client = new APIClient(ctx.config)
        const getAuth = sinon.spy(client, 'getAuth')
        const HTTPClient = client.http
        const request = new HTTPClient('/direct-trusted')

        await request._request()

        expect(getAuth.calledOnce).to.be.true
      })

    test
      .it('generates JSON entity headers for external bodies without inheriting default headers', async ctx => {
        const body = {external: true}
        const serialized = JSON.stringify(body)
        const external = nock('https://example.com', {
          badheaders: ['x-inherited-secret'],
          reqheaders: {
            'content-length': String(Buffer.byteLength(serialized)),
            'content-type': 'application/json',
          },
        })
          .post('/json', body)
          .reply(200, {})
        const client = new APIClient(ctx.config)
        Object.assign(client.defaults.headers!, {
          'content-type': 'text/plain',
          'x-inherited-secret': 'default-secret',
        })

        await client.post('https://example.com/json', {body})

        external.done()
      })

    test
      .it('preserves request streams without generating an inherited content type', async ctx => {
        const external = nock('https://example.com', {badheaders: ['content-type', 'x-inherited-secret']})
          .post('/stream', 'stream-body')
          .reply(200, {})
        const client = new APIClient(ctx.config)
        Object.assign(client.defaults.headers!, {
          'content-type': 'text/plain',
          'x-inherited-secret': 'default-secret',
        })

        await client.post('https://example.com/stream', {body: Readable.from(['stream-body'])})

        external.done()
      })

    test
      .it('preserves raw response streaming through the guarded transport path', async ctx => {
        api.get('/stream-response').reply(200, 'stream-response')
        const client = new APIClient(ctx.config)

        const {body, response} = await client.stream('/stream-response')
        let streamed = ''
        for await (const chunk of response) streamed += chunk

        expect(body).to.be.undefined
        expect(streamed).to.equal('stream-response')
      })

    for (const target of [
      'https://api.heroku.com/apps',
      'HTTPS://api.heroku.com/apps',
      'http://localhost:5100/apps',
      'http://127.42.0.9:5101/apps',
      'http://[::1]:5102/apps',
    ]) {
      test
        .it(`attaches authorization to ${target}`, async ctx => {
          const parsed = new URL(target)
          const scope = nock(parsed.origin, {reqheaders: {authorization: 'Bearer mypass'}})
            .get(parsed.pathname)
            .reply(200, [])
          const client = new APIClient(ctx.config)

          await client.get(target)
          scope.done()
        })
    }

    for (const target of [
      'http://api.heroku.com/apps',
      'http://staging.heroku.com/apps',
      'http://localhost.evil.example/apps',
      'http://128.0.0.1/apps',
      'https://example.com/apps',
    ]) {
      test
        .it(`does not attach authorization to ${target}`, async ctx => {
          const parsed = new URL(target)
          const scope = nock(parsed.origin, {badheaders: ['authorization']})
            .get(parsed.pathname)
            .reply(200, [])
          const client = new APIClient(ctx.config)

          await client.get(target)
          scope.done()
        })
    }

    for (const target of [
      'https://example.com/account',
      'http://api.heroku.com/account',
    ]) {
      test
        .it(`does not login or attach authorization when ${target} returns 401`, async ctx => {
          const parsed = new URL(target)
          const scope = nock(parsed.origin, {badheaders: ['authorization']})
            .get(parsed.pathname)
            .reply(401, {id: 'unauthorized', message: 'nope'})
          const client = new APIClient(ctx.config)
          const login = sinon.stub(client, 'login').rejects(new Error('login invoked'))

          await chaiExpect(client.get(target)).to.be.rejectedWith('nope')

          expect(login.called).to.be.false
          scope.done()
        })
    }

    test
      .it('uses the hostname and port that Node will contact for an absolute URL override', async ctx => {
        const external = nock('https://example.com:4443', {
          badheaders: ['authorization', 'heroku-two-factor-code', requestIdHeader],
        })
          .get('/apps')
          .reply(401, {id: 'unauthorized', message: 'external unauthorized'})
        const client = new APIClient(ctx.config)
        const login = sinon.stub(client, 'login').rejects(new Error('login invoked'))

        await chaiExpect(client.get('https://api.heroku.com/apps', {
          headers: {'Heroku-Two-Factor-Code': '123456'},
          hostname: 'example.com',
          port: 4443,
        })).to.be.rejectedWith('external unauthorized')

        expect(login.called).to.be.false
        external.done()
      })

    test
      .it('honors http-call precedence when absolute URL protocol, host, and path cannot be overridden', async ctx => {
        api = nock('https://api.heroku.com', {reqheaders: {authorization: 'Bearer mypass'}})
          .get('/apps')
          .reply(200, [])
        const client = new APIClient(ctx.config)

        await client.get('https://api.heroku.com/apps', {
          host: 'example.com',
          path: '/not-apps',
          protocol: 'http:',
        })
      })

    test
      .it('applies protocol and hostname overrides to relative requests before authorizing', async ctx => {
        const external = nock('http://example.com', {badheaders: ['authorization', requestIdHeader]})
          .get('/apps')
          .reply(200, [])
        const client = new APIClient(ctx.config)

        await client.get('/apps', {hostname: 'example.com', protocol: 'http:'})

        external.done()
      })

    test
      .it('normalizes a default HTTPS port when enforcing same-origin redirects', async ctx => {
        api = nock('https://api.heroku.com', {reqheaders: {authorization: 'Bearer mypass'}})
          .get('/redirect-default-port')
          .reply(302, undefined, {Location: 'https://api.heroku.com:443/final'})
          .get('/final')
          .reply(200, {ok: true})
        const client = new APIClient(ctx.config)

        const {body} = await client.get('/redirect-default-port')

        expect(body).to.deep.equal({ok: true})
      })

    test
      .it('uses the effective overridden origin when enforcing redirect ownership', async ctx => {
        const external = nock('https://example.com:4443')
          .get('/redirect')
          .reply(302, undefined, {Location: '/final'})
          .get('/final')
          .reply(200, {ok: true})
        const client = new APIClient(ctx.config)

        const {body} = await client.get('https://api.heroku.com/redirect', {
          hostname: 'example.com',
          port: 4443,
        })

        expect(body).to.deep.equal({ok: true})
        external.done()
      })

    test
      .it('does not login or replace caller authorization after a trusted 401', async ctx => {
        api = nock('https://api.heroku.com', {reqheaders: {authorization: 'Bearer caller-token'}})
          .get('/caller-auth')
          .reply(401, {id: 'unauthorized', message: 'caller unauthorized'})
        const options = {headers: {Authorization: 'Bearer caller-token'}}
        const client = new APIClient(ctx.config)
        const login = sinon.stub(client, 'login').rejects(new Error('login invoked'))

        await chaiExpect(client.get('/caller-auth', options)).to.be.rejectedWith('caller unauthorized')

        expect(login.called).to.be.false
        expect(options).to.deep.equal({headers: {Authorization: 'Bearer caller-token'}})
      })

    test
      .it('does not mutate or leak generated headers when request options are reused across targets', async ctx => {
        api = nock('https://api.heroku.com', {reqheaders: {authorization: 'Bearer mypass'}})
          .get('/trusted')
          .reply(200, [])
        const external = nock('https://example.com', {
          badheaders: ['authorization', 'heroku-two-factor-code', requestIdHeader],
          reqheaders: {'x-caller': 'preserved'},
        })
          .get('/external')
          .reply(200, [])
        const options = {headers: {'X-Caller': 'preserved'}}
        const client = new APIClient(ctx.config)

        await client.get('/trusted', options)
        expect(options).to.deep.equal({headers: {'X-Caller': 'preserved'}})
        await client.get('https://example.com/external', options)

        expect(options).to.deep.equal({headers: {'X-Caller': 'preserved'}})
        external.done()
      })

    test
      .it('sanitizes caller-visible options reused from a completed direct request', async ctx => {
        api = nock('https://api.heroku.com', {reqheaders: {authorization: 'Bearer mypass'}})
          .get('/direct-trusted')
          .reply(200, [])
        const external = nock('https://example.com', {
          badheaders: ['authorization', 'cookie', 'heroku-two-factor-code', requestIdHeader, 'x-default-secret'],
        })
          .get('/external')
          .reply(200, [])
        const client = new APIClient(ctx.config)
        Object.assign(client.defaults.headers!, {
          cookie: 'default-cookie-secret',
          'x-default-secret': 'default-header-secret',
        })
        const HTTPClient = client.http
        const first = new HTTPClient('/direct-trusted')

        await first._request()
        const reusedOptions = first.options
        const second = new HTTPClient('https://example.com/external', reusedOptions)
        await second._request()

        external.done()
      })

    test
      .it('keeps generated retry authorization internal to the request clone', async ctx => {
        api = nock('https://api.heroku.com')
          .get('/retry-clone')
          .reply(401, {id: 'unauthorized', message: 'stale'})
          .get('/retry-clone')
          .matchHeader('authorization', 'Bearer fresh-token')
          .reply(200, [])
        const options = {headers: {'X-Caller': 'preserved'}}
        const client = new APIClient(ctx.config)
        sinon.stub(client, 'login').callsFake(async () => {
          client.setAuthEntry({account: undefined, token: 'fresh-token'})
          return undefined as any
        })

        await client.get('/retry-clone', options)

        expect(options).to.deep.equal({headers: {'X-Caller': 'preserved'}})
      })

    test
      .it('keeps a prompted two-factor code internal to the request clone', async ctx => {
        const scope = nock('https://api.heroku.com')
          .get('/two-factor-clone')
          .reply(403, {id: 'two_factor'})
          .get('/two-factor-clone')
          .matchHeader('heroku-two-factor-code', '123456')
          .reply(200, [])
        const options = {headers: {'X-Caller': 'preserved'}}
        const client = new APIClient(ctx.config)
        sinon.stub(client, 'twoFactorPrompt').resolves('123456')

        await client.get('/two-factor-clone', options)

        expect(options).to.deep.equal({headers: {'X-Caller': 'preserved'}})
        scope.done()
      })
  })

  describe('redirect target policy', () => {
    test
      .it('keeps loopback redirects and transport retries direct when a credentialed proxy is configured', async ctx => {
        const requests: Array<{authorization: string | undefined; url: string | undefined}> = []
        let retryAttempts = 0
        const destination = createServer((request, response) => {
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

          if (retryAttempts === 2) {
            response.setHeader('content-type', 'application/json')
            response.writeHead(401)
            response.end('{"id":"unauthorized","message":"stale"}')
            return
          }

          response.setHeader('content-type', 'application/json')
          response.end('{"ok":true}')
        })
        const proxyRequests: Array<{authorization: string | undefined; proxyAuthorization: string | undefined}> = []
        const proxy = createServer((request, response) => {
          proxyRequests.push({
            authorization: request.headers.authorization,
            proxyAuthorization: request.headers['proxy-authorization'],
          })
          response.writeHead(502)
          response.end()
        })
        const listen = async (server: ReturnType<typeof createServer>): Promise<number> => {
          await new Promise<void>((resolveListen, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolveListen)
          })
          return (server.address() as AddressInfo).port
        }

        const close = (server: ReturnType<typeof createServer>) => new Promise<void>((resolveClose, reject) => {
          server.close(error => error ? reject(error) : resolveClose())
        })
        const destinationPort = await listen(destination)
        const proxyPort = await listen(proxy)

        process.env.HTTP_PROXY = `http://proxy-user:proxy-password@127.0.0.1:${proxyPort}`
        process.env.http_proxy = process.env.HTTP_PROXY
        nock.restore()

        try {
          const client = new APIClient(ctx.config)
          sinon.stub(client, 'login').callsFake(async () => {
            client.setAuthEntry({account: undefined, token: 'fresh-token'})
            return undefined as any
          })
          const {body} = await client.get(`http://127.0.0.1:${destinationPort}/start`)

          expect(body).to.deep.equal({ok: true})
          expect(requests).to.deep.equal([
            {authorization: 'Bearer mypass', url: '/start'},
            {authorization: 'Bearer mypass', url: '/retry'},
            {authorization: 'Bearer mypass', url: '/retry'},
            {authorization: 'Bearer fresh-token', url: '/start'},
            {authorization: 'Bearer fresh-token', url: '/retry'},
          ])
          expect(proxyRequests).to.deep.equal([])
        } finally {
          await Promise.all([close(destination), close(proxy)])
          nock.activate()
        }
      })

    test
      .it('preserves authorization and follows relative same-origin redirects', async ctx => {
        api = nock('https://api.heroku.com', {reqheaders: {authorization: 'Bearer mypass'}})
          .get('/nested/redirect')
          .reply(302, undefined, {Location: 'final'})
          .get('/nested/final')
          .reply(200, {ok: true})
        const client = new APIClient(ctx.config)

        const {body} = await client.get('/nested/redirect')

        expect(body).to.deep.equal({ok: true})
      })

    test
      .it('preserves method and body across same-origin redirects', async ctx => {
        api = nock('https://api.heroku.com', {reqheaders: {authorization: 'Bearer mypass'}})
          .post('/redirect-body', {preserved: true})
          .reply(307, undefined, {Location: '/final-body'})
          .post('/final-body', {preserved: true})
          .reply(200, {ok: true})
        const client = new APIClient(ctx.config)

        const {body} = await client.post('/redirect-body', {body: {preserved: true}})

        expect(body).to.deep.equal({ok: true})
      })

    for (const redispatch of ['redirect', 'transport retry'] as const) {
      test
        .it(`rejects a non-replayable stream before a ${redispatch} redispatch`, async ctx => {
          const secret = `api-${redispatch}-body-secret`
          const requests: Array<{body: string; url: string | undefined}> = []
          const server = createServer((request, response) => {
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
          await new Promise<void>((resolveListen, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolveListen)
          })
          const {port} = server.address() as AddressInfo
          nock.restore()

          try {
            const client = new APIClient(ctx.config)
            const failure = await rejectionWithin(client.post(`http://127.0.0.1:${port}/start`, {
              body: Readable.from([secret]),
            }))

            expect(failure.message).to.match(/non-replayable.*body/i)
            expect(failure.message).not.to.contain(secret)
            expect(requests).to.deep.equal([{body: secret, url: '/start'}])
          } finally {
            await new Promise<void>((resolveClose, reject) => {
              server.close(error => error ? reject(error) : resolveClose())
            })
            nock.activate()
          }
        })
    }

    test
      .it('rejects same-origin redirects containing URL credentials before dispatch', async ctx => {
        const opaqueAuthorizationId = 'opaque-authorization-id'
        const redirectUser = 'redirect-user-secret'
        const redirectPassword = 'redirect-password-secret'
        api = nock('https://api.heroku.com')
          .get('/credential-redirect')
          .reply(302, undefined, {
            Location: `https://${redirectUser}:${redirectPassword}@api.heroku.com/oauth/authorizations/${opaqueAuthorizationId}?token=query-secret#fragment-secret`,
          })
        const client = new APIClient(ctx.config)
        let failure: unknown

        try {
          await client.get('/credential-redirect')
        } catch (error) {
          failure = error
        }

        expect(failure).to.be.instanceOf(Error)
        const diagnostic = JSON.stringify(failure, Object.getOwnPropertyNames(failure as object))
        for (const secret of [redirectUser, redirectPassword, opaqueAuthorizationId, 'query-secret', 'fragment-secret']) {
          expect(`${(failure as Error).message}\n${diagnostic}`).not.to.contain(secret)
        }
      })

    test
      .it('rejects initial API request URLs containing credentials without exposing them', async ctx => {
        const client = new APIClient(ctx.config)
        const target = 'https://api-user:api-password@api.heroku.com/oauth/authorizations/opaque-initial-id?token=api-query-secret#api-fragment-secret'
        let failure: unknown

        try {
          await client.get(target)
        } catch (error) {
          failure = error
        }

        expect(failure).to.be.instanceOf(Error)
        expect((failure as Error).message).to.contain('https://api.heroku.com')
        for (const secret of ['api-user', 'api-password', 'opaque-initial-id', 'api-query-secret', 'api-fragment-secret']) {
          expect(`${(failure as Error).message}\n${JSON.stringify(failure)}`).not.to.contain(secret)
        }
      })

    test
      .it('rejects cross-origin redirects before sensitive Heroku headers reach the target', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {
            authorization: 'Bearer mypass',
            'heroku-two-factor-code': '123456',
            'x-heroku-sensitive': 'secret',
          },
        })
          .get('/redirect')
          .reply(302, undefined, {Location: 'https://example.com/target'})
        let targetRequested = false
        nock('https://example.com')
          .get('/target')
          .reply(() => {
            targetRequested = true
            return [200, {}]
          })
        const client = new APIClient(ctx.config)

        await chaiExpect(client.get('/redirect', {
          headers: {
            'Heroku-Two-Factor-Code': '123456',
            'X-Heroku-Sensitive': 'secret',
          },
        })).to.be.rejectedWith(/cross-origin redirect/i)

        expect(targetRequested).to.be.false
      })

    test
      .it('reports only source and target origins for rejected cross-origin redirects', async ctx => {
        const target = createServer((_request, response) => response.end('{}'))
        const source = createServer((_request, response) => {
          const targetPort = (target.address() as AddressInfo).port
          response.writeHead(302, {Location: `http://target-user:target-password@127.0.0.1:${targetPort}/target-private?target-query=secret#target-fragment`})
          response.end()
        })
        const listen = async (server: ReturnType<typeof createServer>): Promise<number> => {
          await new Promise<void>((resolveListen, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolveListen)
          })
          return (server.address() as AddressInfo).port
        }

        const close = (server: ReturnType<typeof createServer>) => new Promise<void>((resolveClose, reject) => {
          server.close(error => error ? reject(error) : resolveClose())
        })
        const targetPort = await listen(target)
        const sourcePort = await listen(source)

        nock.restore()
        let failure: unknown

        try {
          const client = new APIClient(ctx.config)
          await client.get(`http://127.0.0.1:${sourcePort}/source-private?source-query=secret`)
        } catch (error) {
          failure = error
        } finally {
          await Promise.all([close(source), close(target)])
          nock.activate()
        }

        expect(failure).to.be.instanceOf(Error)
        const {message} = failure as Error
        expect(message).to.contain(`http://127.0.0.1:${sourcePort}`)
        expect(message).to.contain(`http://127.0.0.1:${targetPort}`)
        for (const secret of ['source-private', 'source-query', 'target-user', 'target-password', 'target-private', 'target-query', 'target-fragment']) {
          expect(message).not.to.contain(secret)
        }
      })

    test
      .it('sanitizes authorization URLs in debug output and HTTP errors', async ctx => {
        const opaqueAuthorizationId = 'opaque-auth-debug-id'
        api = nock('https://api.heroku.com')
          .get(`/oauth/authorizations/${opaqueAuthorizationId}`)
          .query({token: 'query-debug-secret'})
          .reply(404, {id: 'not_found', message: 'missing'})
        const client = new APIClient(ctx.config)
        debug.enable('http')
        stderr.start()
        let failure: unknown
        try {
          await client.get(`/oauth/authorizations/${opaqueAuthorizationId}?token=query-debug-secret#fragment-debug-secret`)
        } catch (error) {
          failure = error
        } finally {
          stderr.stop()
          debug.disable()
        }

        expect(failure).to.be.instanceOf(Error)
        expect((failure as any).http.http.url).to.equal('https://api.heroku.com/oauth/authorizations/:id')
        expect(stderr.output).to.contain('https://api.heroku.com/oauth/authorizations/:id')
        const diagnostic = `${stderr.output}\n${(failure as Error).message}\n${(failure as any).http.http.url}\n${JSON.stringify((failure as any).body)}`
        for (const secret of [opaqueAuthorizationId, 'query-debug-secret', 'fragment-debug-secret']) {
          expect(diagnostic).not.to.contain(secret)
        }
      })

    test
      .it('uses a generic path for unknown API routes in debug output', async ctx => {
        const opaqueRouteId = 'opaque-unknown-route-id'
        api = nock('https://api.heroku.com')
          .get(`/private/${opaqueRouteId}`)
          .query({token: 'unknown-query-secret'})
          .reply(200, {})
        const client = new APIClient(ctx.config)
        debug.enable('http')
        stderr.start()
        try {
          await client.get(`/private/${opaqueRouteId}?token=unknown-query-secret#unknown-fragment-secret`)
        } finally {
          stderr.stop()
          debug.disable()
        }

        expect(stderr.output).to.contain('https://api.heroku.com/[redacted]')
        for (const secret of [opaqueRouteId, 'unknown-query-secret', 'unknown-fragment-secret']) {
          expect(stderr.output).not.to.contain(secret)
        }
      })
  })

  test
    .it('accepts an explicit resolvedVars snapshot for all APIClient configuration', async ctx => {
      const resolvedVars = {
        apiHost: 'localhost:5200',
        apiUrl: 'http://localhost:5200',
        gitHost: 'localhost:5201',
        gitPrefixes: ['git@localhost:5201:', 'ssh://git@localhost:5201/', 'https://localhost:5201/'],
        host: 'http://localhost:5200',
        httpGitHost: 'localhost:5201',
      }
      process.env.HEROKU_HOST = 'staging.heroku.com'
      const localApi = nock(resolvedVars.apiUrl, {reqheaders: {authorization: 'Bearer mypass'}})
        .get('/apps')
        .reply(200, [])

      const client = new APIClient(ctx.config, {}, resolvedVars)
      expect(client.resolvedVars).to.equal(resolvedVars)
      await client.get('/apps')
      localApi.done()
    })

  describe('Platform API error documentation URLs', () => {
    for (const documentationUrl of [
      'https://devcenter.heroku.com/articles/platform-api-reference',
      'https://devcenter.heroku.com/articles/platform-api-reference#rate-limits',
      'https://devcenter.heroku.com/articles/platform-api-reference/',
    ]) {
      test
        .it(`preserves ${documentationUrl}`, async ctx => {
          api.get('/documentation-error').reply(422, {
            detail: 'retained detail',
            message: 'request failed',
            metadata: {retryable: false},
            url: documentationUrl,
          })
          const client = new APIClient(ctx.config)
          const failure = await rejectionWithin(client.get('/documentation-error'))

          expect(failure).to.be.instanceOf(HerokuAPIError)
          const mapped = failure as HerokuAPIError
          expect(mapped.message).to.equal(`request failed\n\nSee ${documentationUrl} for more information.`)
          for (const body of [mapped.body, mapped.http.body, mapped.http.http.body]) {
            expect(body).to.deep.equal({
              detail: 'retained detail',
              message: 'request failed',
              metadata: {retryable: false},
              url: documentationUrl,
            })
          }
        })
    }

    test
      .it('accepts normalized hostname spelling in a documentation URL', async ctx => {
        const documentationUrl = 'https://DEVCENTER.HEROKU.COM:443/articles/platform-api-reference#rate-limits'
        const normalizedUrl = 'https://devcenter.heroku.com/articles/platform-api-reference#rate-limits'
        api.get('/documentation-error').reply(422, {message: 'request failed', url: documentationUrl})
        const client = new APIClient(ctx.config)
        const failure = await rejectionWithin(client.get('/documentation-error'))

        expect(failure).to.be.instanceOf(HerokuAPIError)
        const mapped = failure as HerokuAPIError
        expect(mapped.message).to.equal(`request failed\n\nSee ${normalizedUrl} for more information.`)
        for (const body of [mapped.body, mapped.http.body, mapped.http.http.body]) {
          expect(body.url).to.equal(normalizedUrl)
        }
      })

    for (const [kind, unsafeUrl, secret] of [
      ['authorization', 'https://api.heroku.com/oauth/authorizations/authorization-secret', 'authorization-secret'],
      ['query', 'https://devcenter.heroku.com/articles/platform-api-reference?token=query-secret', 'query-secret'],
      ['userinfo', 'https://userinfo-secret@devcenter.heroku.com/articles/platform-api-reference', 'userinfo-secret'],
      ['scheme', 'http://devcenter.heroku.com/articles/scheme-secret', 'scheme-secret'],
      ['lookalike', 'https://devcenter.heroku.com.lookalike-secret.example/articles/platform-api-reference', 'lookalike-secret'],
      ['nondefault port', 'https://devcenter.heroku.com:8443/articles/port-secret', 'port-secret'],
    ]) {
      test
        .it(`omits an unsafe ${kind} URL from every projected error body`, async ctx => {
          api.get('/documentation-error').reply(422, {
            detail: 'retained detail',
            message: 'request failed',
            metadata: {retryable: true},
            url: unsafeUrl,
          })
          const client = new APIClient(ctx.config)
          const failure = await rejectionWithin(client.get('/documentation-error'))

          expect(failure).to.be.instanceOf(HerokuAPIError)
          const mapped = failure as HerokuAPIError
          expect(mapped.message).to.equal('request failed')
          for (const body of [mapped.body, mapped.http.body, mapped.http.http.body]) {
            expect(body).to.deep.equal({
              detail: 'retained detail',
              message: 'request failed',
              metadata: {retryable: true},
            })
          }

          expect(mapped.http.message).to.equal('HTTP Error 422 for GET https://api.heroku.com/[redacted]\nrequest failed')
          expect(mapped.http.message).not.to.contain('retained detail')
          expect(mapped.http.message).not.to.contain('retryable')

          for (const exposed of [mapped.message, mapped.body, mapped.http.message, mapped.http.body, mapped.http.http.body]) {
            const diagnostic = typeof exposed === 'string' ? exposed : JSON.stringify(exposed)
            expect(diagnostic).not.to.contain(unsafeUrl)
            expect(diagnostic).not.to.contain(secret)
          }
        })
    }

    for (const [kind, message] of [
      ['missing', undefined],
      ['blank', '   '],
      ['non-string', 42],
    ] as const) {
      test
        .it(`sanitizes an unsafe URL when the response message is ${kind}`, async ctx => {
          const unsafeUrl = `https://attacker.example.com/remediation/${kind}-secret`
          const body: {detail: string; id: string; message?: number | string; url: string} = {
            detail: `${kind}-body-secret`,
            id: 'invalid_response',
            url: unsafeUrl,
          }
          if (message !== undefined) body.message = message
          api.get('/documentation-error').reply(422, body)
          const client = new APIClient(ctx.config)
          const failure = await rejectionWithin(client.get('/documentation-error'))

          expect(failure).to.be.instanceOf(HTTPError)
          expect(failure).not.to.be.instanceOf(HerokuAPIError)
          const mapped = failure as HTTPError
          expect(mapped.message).to.contain('HTTP Error 422 for GET https://api.heroku.com/[redacted]\n')
          expect(mapped.message).to.contain(`detail: '${kind}-body-secret'`)
          expect(mapped.message).to.contain("id: 'invalid_response'")
          for (const exposedBody of [mapped.body, mapped.http.body]) {
            expect(exposedBody).to.deep.equal({
              detail: `${kind}-body-secret`,
              id: 'invalid_response',
              ...(message === undefined ? {} : {message}),
            })
          }

          for (const exposed of [mapped.message, mapped.body, mapped.http.body]) {
            const diagnostic = typeof exposed === 'string' ? exposed : JSON.stringify(exposed)
            expect(diagnostic).not.to.contain(unsafeUrl)
            expect(diagnostic).not.to.contain(`${kind}-secret`)
          }
        })
    }

    for (const [kind, body, expectedDetail] of [
      ['string', 'historical string response', 'historical string response'],
      ['array', ['historical array response', {detail: 'retained'}], "[ 'historical array response', { detail: 'retained' } ]"],
      ['number', 42, '42'],
    ] as const) {
      test
        .it(`preserves historical HTTPError behavior for a malformed ${kind} response body`, async ctx => {
          api.get('/malformed-error').reply(502, body)
          const client = new APIClient(ctx.config)
          const failure = await rejectionWithin(client.get('/malformed-error'))

          expect(failure).to.be.instanceOf(HTTPError)
          expect(failure).not.to.be.instanceOf(HerokuAPIError)
          const mapped = failure as HTTPError
          expect(mapped.message).to.equal(`HTTP Error 502 for GET https://api.heroku.com/[redacted]\n${expectedDetail}`)
          expect(mapped.statusCode).to.equal(502)
          expect(mapped.http.statusCode).to.equal(502)
          expect(mapped.body).to.deep.equal(body)
          expect(mapped.http.body).to.deep.equal(body)
        })
    }

    test
      .it('refreshes a pre-materialized fallback stack after sanitizing response and request URLs', () => {
        const unsafeResponseUrl = 'https://attacker.example.com/remediation/response-url-secret'
        const rawRequestUrl = 'https://api.heroku.com/apps/raw-request-secret?token=request-query-secret'
        const body = {detail: 'retained detail', id: 'invalid_response', url: unsafeResponseUrl}
        const httpError = new HTTPError({
          body,
          method: 'GET',
          statusCode: 422,
          url: rawRequestUrl,
        } as unknown as ConstructorParameters<typeof HTTPError>[0])
        const originalStack = httpError.stack
        expect(originalStack).to.contain('response-url-secret')
        expect(originalStack).to.contain('raw-request-secret')

        let failure: unknown
        try {
          failure = new HerokuAPIError(httpError)
        } catch (error) {
          failure = error
        }

        expect(failure).to.equal(httpError)
        expect(httpError.body).to.deep.equal({detail: 'retained detail', id: 'invalid_response'})
        expect(httpError.http.body).to.equal(httpError.body)
        expect(httpError.message).to.contain('HTTP Error 422 for GET https://api.heroku.com/[redacted]')
        expect(httpError.message).to.contain("detail: 'retained detail'")
        expect(httpError.stack).to.contain(httpError.message)
        for (const secret of [unsafeResponseUrl, 'response-url-secret', rawRequestUrl, 'raw-request-secret', 'request-query-secret']) {
          expect(httpError.stack).not.to.contain(secret)
        }
      })
  })

  describe('request for Account Info endpoint', () => {
    test
      .it('does not send credentials to a Particleboard endpoint changed after construction', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/account').reply(200, [{id: 'myid'}])
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
          .get('/account')
          .replyWithError('Particleboard unavailable')
        const attackerAuthorization: Array<string | undefined> = []
        const attacker = nock('https://attacker.example.com')
          .get('/account')
          .reply(function () {
            attackerAuthorization.push(this.req.headers.authorization)
            return [200, {}]
          })
        const client = new APIClient(ctx.config)

        process.env.HEROKU_PARTICLEBOARD_URL = 'https://attacker.example.com'
        const {body} = await client.get('/account')

        expect(body).to.deep.equal([{id: 'myid'}])
        particleboard.done()
        expect(attackerAuthorization).to.deep.equal([])
        expect(attacker.isDone()).to.be.false
      })

    test
      .it('uses an explicit Particleboard endpoint snapshot after environment mutation', async ctx => {
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer particleboard-token'},
        })
          .get('/account')
          .reply(200, {})
        const attacker = nock('https://attacker.example.com')
          .get('/account')
          .reply(200, {})
        const client = new ParticleboardClient(ctx.config, 'https://particleboard.heroku.com')
        client.auth = 'particleboard-token'

        process.env.HEROKU_PARTICLEBOARD_URL = 'https://attacker.example.com'
        await client.get('/account')

        particleboard.done()
        expect(attacker.isDone()).to.be.false
      })

    test
      .it('sends requests to Platform API and Particleboard', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/account').reply(200, [{id: 'myid'}])
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/account').reply(200, {id: 'acct_id'})

        const cmd = new Command([], ctx.config)
        const {body} = await cmd.heroku.get('/account')
        expect(body).to.deep.equal([{id: 'myid'}])
        particleboard.done()
      })

    for (const [name, apiUrl] of [
      ['loopback', 'http://127.0.0.1:5200'],
      ['staging', 'https://api.staging.heroku.com'],
    ]) {
      test
        .it(`does not send a ${name} API credential to production Particleboard`, async ctx => {
          api = nock(apiUrl, {reqheaders: {authorization: 'Bearer custom-scope-token'}})
            .get('/account')
            .reply(200, {id: 'custom-account'})
          let particleboardRequested = false
          const particleboard = nock('https://particleboard.heroku.com')
            .get('/account')
            .reply(() => {
              particleboardRequested = true
              return [200, {}]
            })
          const parsedApiUrl = new URL(apiUrl)
          const client = new APIClient(ctx.config, {}, {
            apiHost: parsedApiUrl.host,
            apiUrl,
            gitHost: parsedApiUrl.host,
            gitPrefixes: [],
            host: apiUrl,
            httpGitHost: parsedApiUrl.host,
          })
          client.auth = 'custom-scope-token'

          const {body} = await client.get('/account')

          expect(body).to.deep.equal({id: 'custom-account'})
          expect(particleboardRequested).to.be.false
          expect(particleboard.isDone()).to.be.false
        })
    }

    test
      .it('doesn\'t fail or show delinquency warnings if Particleboard request fails', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/account').reply(200, [{id: 'myid'}])
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/account').reply(401)

        stderr.start()
        const cmd = new Command([], ctx.config)
        const {body} = await cmd.heroku.get('/account')

        expect(body).to.deep.equal([{id: 'myid'}])
        expect(stderr.output).to.eq('')
        stderr.stop()
        particleboard.done()
      })

    test
      .it('doesn\'t show delinquency warnings if account isn\'t delinquent', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/account').reply(200, [{id: 'myid'}])
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/account').reply(200, {
          scheduled_deletion_time: null,
          scheduled_suspension_time: null,
        })

        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/account')

        expect(stderr.output).to.eq('')
        stderr.stop()
        particleboard.done()
      })

    test
      .it('shows a delinquency warning with suspension date if account is delinquent and suspension is in the future', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/account').reply(200, [{id: 'myid'}])
        const now = Date.now()
        const suspensionTime = new Date(now + (10 * 60 * 60 * 24 * 1000)) // 10 days in the future
        const deletionTime = new Date(now + (30 * 60 * 60 * 24 * 1000)) // 30 days in the future
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/account').reply(200, {
          scheduled_deletion_time: deletionTime.toISOString(),
          scheduled_suspension_time: suspensionTime.toISOString(),
        })

        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/account')

        const stderrOutput = stderr.output.replaceAll(/ *[»›] */g, '').replaceAll(/ *\n */g, ' ')
        expect(stderrOutput).to.include(`Warning: This account is delinquent with payment and we'll suspend it on ${suspensionTime}`)
        stderr.stop()
        particleboard.done()
      })

    test
      .it('shows a delinquency warning with deletion date if account is delinquent and suspension is in the past', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/account').reply(200, [{id: 'myid'}])
        const now = Date.now()
        const suspensionTime = new Date(now - (60 * 60 * 24 * 1000)) // 1 day in the past
        const deletionTime = new Date(now + (20 * 60 * 60 * 24 * 1000)) // 20 days in the future
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/account').reply(200, {
          scheduled_deletion_time: deletionTime.toISOString(),
          scheduled_suspension_time: suspensionTime.toISOString(),
        })

        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/account')

        const stderrOutput = stderr.output.replaceAll(/ *[»›] */g, '').replaceAll(/ *\n */g, ' ')
        expect(stderrOutput).to.include(`Warning: This account is delinquent with payment and we suspended it on ${suspensionTime}. If the account is still delinquent, we'll delete it on ${deletionTime}`)
        stderr.stop()
        particleboard.done()
      })

    test
      .it('it doesn\'t send a Particleboard request or show duplicated delinquency warnings with multiple matching requests when delinquent', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/account').reply(200, [{id: 'myid'}])
        api.get('/account').reply(200, [{id: 'myid'}])
        const now = Date.now()
        const suspensionTime = new Date(now + (10 * 60 * 60 * 24 * 1000)) // 10 days in the future
        const deletionTime = new Date(now + (30 * 60 * 60 * 24 * 1000)) // 30 days in the future
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard
          .get('/account').reply(200, {
            scheduled_deletion_time: deletionTime.toISOString(),
            scheduled_suspension_time: suspensionTime.toISOString(),
          })

        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/account')

        const stderrOutput = stderr.output.replaceAll(/ *[»›] */g, '').replaceAll(/ *\n */g, ' ')
        expect(stderrOutput).to.include(`Warning: This account is delinquent with payment and we'll suspend it on ${suspensionTime}`)
        stderr.stop()

        stderr.start()
        await cmd.heroku.get('/account')
        expect(stderr.output).to.eq('')
        stderr.stop()
        particleboard.done()
      })
  })

  describe('team namespaced requests', () => {
    test
      .it('sends requests to Platform API and Particleboard', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/teams/my_team/members').reply(200, [{id: 'member_id'}])
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/teams/my_team').reply(200, {id: 'my_team_id', name: 'my_team'})

        const cmd = new Command([], ctx.config)
        const {body} = await cmd.heroku.get('/teams/my_team/members')

        expect(body).to.deep.equal([{id: 'member_id'}])
        particleboard.done()
      })

    test
      .it('doesn\'t fail or show delinquency warnings if Particleboard request fails', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/teams/my_team/members').reply(200, [{id: 'member_id'}])
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/teams/my_team').reply(404, {id: 'not_found', message: 'Team not found', resource: 'team'})

        stderr.start()
        const cmd = new Command([], ctx.config)
        const {body} = await cmd.heroku.get('/teams/my_team/members')

        expect(body).to.deep.equal([{id: 'member_id'}])
        expect(stderr.output).to.eq('')
        stderr.stop()
        particleboard.done()
      })

    test
      .it('doesn\'t show delinquency warnings if team isn\'t delinquent', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/teams/my_team/members').reply(200, [{id: 'member_id'}])
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/teams/my_team').reply(200, {
          scheduled_deletion_time: null,
          scheduled_suspension_time: null,
        })

        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/teams/my_team/members')

        expect(stderr.output).to.eq('')
        stderr.stop()
        particleboard.done()
      })

    test
      .it('shows a delinquency warning with suspension date if team is delinquent and suspension is in the future', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/teams/my_team/members').reply(200, [{id: 'member_id'}])
        const now = Date.now()
        const suspensionTime = new Date(now + (10 * 60 * 60 * 24 * 1000)) // 10 days in the future
        const deletionTime = new Date(now + (30 * 60 * 60 * 24 * 1000)) // 30 days in the future
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/teams/my_team').reply(200, {
          scheduled_deletion_time: deletionTime.toISOString(),
          scheduled_suspension_time: suspensionTime.toISOString(),
        })

        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/teams/my_team/members')

        const stderrOutput = stderr.output.replaceAll(/ *[»›] */g, '').replaceAll(/ *\n */g, ' ')
        expect(stderrOutput).to.include(`Warning: This team is delinquent with payment and we'll suspend it on ${suspensionTime}`)
        stderr.stop()
        particleboard.done()
      })

    test
      .it('shows a delinquency warning with deletion date if team is delinquent and suspension is in the past', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/teams/my_team/members').reply(200, [{id: 'member_id'}])
        const now = Date.now()
        const suspensionTime = new Date(now - (60 * 60 * 24 * 1000)) // 1 day in the past
        const deletionTime = new Date(now + (20 * 60 * 60 * 24 * 1000)) // 20 days in the future
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/teams/my_team').reply(200, {
          scheduled_deletion_time: deletionTime.toISOString(),
          scheduled_suspension_time: suspensionTime.toISOString(),
        })

        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/teams/my_team/members')

        const stderrOutput = stderr.output.replaceAll(/ *[»›] */g, '').replaceAll(/ *\n */g, ' ')
        expect(stderrOutput).to.include(`Warning: This team is delinquent with payment and we suspended it on ${suspensionTime}. If the team is still delinquent, we'll delete it on ${deletionTime}`)
        stderr.stop()
        particleboard.done()
      })

    test
      .it('it doesn\'t send a Particleboard request or show duplicated delinquency warnings with multiple matching requests when delinquent', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/teams/my_team/members').reply(200, [{id: 'member_id'}])
        api.get('/teams/my_team/members').reply(200, [{id: 'member_id'}])
        const now = Date.now()
        const suspensionTime = new Date(now + (10 * 60 * 60 * 24 * 1000)) // 10 days in the future
        const deletionTime = new Date(now + (30 * 60 * 60 * 24 * 1000)) // 30 days in the future
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard
          .get('/teams/my_team').reply(200, {
            scheduled_deletion_time: deletionTime.toISOString(),
            scheduled_suspension_time: suspensionTime.toISOString(),
          })

        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/teams/my_team/members')

        const stderrOutput = stderr.output.replaceAll(/ *[»›] */g, '').replaceAll(/ *\n */g, ' ')
        expect(stderrOutput).to.include(`Warning: This team is delinquent with payment and we'll suspend it on ${suspensionTime}`)
        stderr.stop()

        stderr.start()
        await cmd.heroku.get('/teams/my_team/members')

        expect(stderr.output).to.eq('')
        stderr.stop()
        particleboard.done()
      })
  })

  test
    .it('2fa no preauth', async ctx => {
      const generateStub = sinon.stub(RequestId, '_generate')
      generateStub.onFirstCall().returns('first-request-id-1234-5678')
      generateStub.onSecondCall().returns('second-request-id-1234-5678')
      RequestId.empty()

      // First request - will trigger 2FA
      const scope = nock('https://api.heroku.com')
        .get('/apps')
        .reply(403, {id: 'two_factor'})

      // Second request - with 2FA code
      scope
        .get('/apps')
        .reply(200, [{name: 'myapp'}])

      const cmd = new Command([], ctx.config)
      // Mock the twoFactorPrompt method
      sinon.stub(cmd.heroku, 'twoFactorPrompt').resolves('123456')
      const {body} = await cmd.heroku.get('/apps')
      expect(body).to.deep.equal([{name: 'myapp'}])

      generateStub.restore()
      scope.done()
    })

  test
    .it('2fa preauth', async ctx => {
      const scope = nock('https://api.heroku.com')
      scope.get('/apps/myapp').reply(403, {app: {name: 'myapp'}, id: 'two_factor'})
      scope.get('/apps/myapp/config').reply(403, {app: {name: 'myapp'}, id: 'two_factor'})
      scope.get('/apps/myapp/dynos').reply(403, {app: {name: 'myapp'}, id: 'two_factor'})
      scope.put('/apps/myapp/pre-authorizations').matchHeader('Heroku-Two-Factor-Code', '123456').reply(200, {})
      scope.get('/apps/myapp').reply(200, {name: 'myapp'})
      scope.get('/apps/anotherapp').reply(200, {name: 'anotherapp'})
      scope.get('/apps/myapp/config').reply(200, {foo: 'bar'})
      scope.get('/apps/myapp/dynos').reply(200, {web: 1})

      const cmd = new Command([], ctx.config)
      // Mock the twoFactorPrompt method
      const promptStub = sinon.stub(cmd.heroku, 'twoFactorPrompt').resolves('123456')
      const info = cmd.heroku.get('/apps/myapp')
      const anotherapp = cmd.heroku.get('/apps/anotherapp')
      const _config = cmd.heroku.get('/apps/myapp/config')
      const dynos = cmd.heroku.get('/apps/myapp/dynos')
      expect((await info).body).to.deep.equal({name: 'myapp'})
      expect((await anotherapp).body).to.deep.equal({name: 'anotherapp'})
      expect((await _config).body).to.deep.equal({foo: 'bar'})
      expect((await dynos).body).to.deep.equal({web: 1})
      expect(promptStub.calledOnce).to.be.true
      scope.done()
    })

  test
    .it('pauses an active action while prompting for 2fa', async ctx => {
      const cmd = new Command([], ctx.config)
      const originalIsTTY = process.stdin.isTTY
      Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: true})
      const promptStub = sinon.stub(prompter, 'prompt').resolves({factor: '123456'})
      const pauseStub = sinon.stub(ux.action, 'pauseAsync').callsFake(async fn => {
        expect(promptStub.called).to.be.false
        const result = await fn()
        expect(promptStub.calledOnce).to.be.true
        return result
      })

      try {
        expect(await cmd.heroku.twoFactorPrompt()).to.equal('123456')
        expect(pauseStub.calledOnce).to.be.true
        expect(promptStub.calledOnce).to.be.true
      } finally {
        pauseStub.restore()
        promptStub.restore()
        Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: originalIsTTY})
      }
    })

  test
    .it('rejects a 2fa prompt without an interactive terminal', async ctx => {
      const cmd = new Command([], ctx.config)
      const originalIsTTY = process.stdin.isTTY
      Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: false})
      const promptStub = sinon.stub(prompter, 'prompt')

      try {
        await chaiExpect(cmd.heroku.twoFactorPrompt()).to.be.rejectedWith('Two-factor authentication requires an interactive terminal.')
        expect(promptStub.called).to.be.false
      } finally {
        promptStub.restore()
        Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: originalIsTTY})
      }
    })

  test
    .it('resumes the action before propagating a 2fa prompt error', async ctx => {
      const cmd = new Command([], ctx.config)
      const originalIsTTY = process.stdin.isTTY
      Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: true})
      const promptStub = sinon.stub(prompter, 'prompt').rejects(new Error('Two-factor prompt canceled'))
      let pauseCallbackCompleted = false
      const pauseStub = sinon.stub(ux.action, 'pauseAsync').callsFake(async fn => {
        const result = await fn()
        pauseCallbackCompleted = true
        return result
      })

      try {
        await chaiExpect(cmd.heroku.twoFactorPrompt()).to.be.rejectedWith('Two-factor prompt canceled')
        expect(pauseCallbackCompleted).to.be.true
        expect(pauseStub.calledOnce).to.be.true
      } finally {
        pauseStub.restore()
        promptStub.restore()
        Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: originalIsTTY})
      }
    })

  context('with HEROKU_DEBUG = "1"', function () {
    context('without HEROKU_DEBUG_HEADERS = "1"', function () {
      test
        .it('enables only HTTP debug info', async ctx => {
          process.env.HEROKU_DEBUG = '1'
          api = nock('https://api.heroku.com', {
            reqheaders: {authorization: 'Bearer mypass'},
          })
          api.get('/apps').reply(200, [{name: 'myapp'}])

          const cmd = new Command([], ctx.config)
          stderr.start()
          await cmd.heroku.get('/apps')
          stderr.stop()

          expect(cmd.heroku.options.debug).to.eq(true)
          expect(cmd.heroku.options.debugHeaders).to.eq(false)
          expect(stderr.output).to.contain('GET https://api.heroku.com/apps')
          expect(stderr.output).not.to.contain("accept: 'application/vnd.heroku+json; version=3")
        })
    })

    context('with HEROKU_DEBUG_HEADERS = "1"', function () {
      test
        .it('enables additional HTTP headers debug info', async ctx => {
          process.env.HEROKU_DEBUG = '1'
          process.env.HEROKU_DEBUG_HEADERS = '1'
          api = nock('https://api.heroku.com', {
            reqheaders: {authorization: 'Bearer mypass'},
          })
          api.get('/apps').reply(200, [{name: 'myapp'}])

          const cmd = new Command([], ctx.config)
          stderr.start()
          await cmd.heroku.get('/apps')
          stderr.stop()

          expect(cmd.heroku.options.debug).to.eq(true)
          expect(cmd.heroku.options.debugHeaders).to.eq(true)
          expect(stderr.output).to.contain('GET https://api.heroku.com/apps')
          expect(stderr.output).to.contain("accept: 'application/vnd.heroku+json; version=3")
        })

      test
        .it('does not log sensitive headers or request and response bodies', async ctx => {
          process.env.HEROKU_DEBUG = '1'
          process.env.HEROKU_DEBUG_HEADERS = '1'
          api.post('/debug-secrets').reply(200, {responseSecret: 'response-body-secret'}, {
            'Set-Cookie': 'response-cookie-secret',
            'X-Heroku-Response-Secret': 'response-header-secret',
          })
          const client = new APIClient(ctx.config, {debug: true, debugHeaders: true})

          stderr.start()
          try {
            await client.post('/debug-secrets', {
              body: {requestSecret: 'request-body-secret'},
              headers: {
                Cookie: 'request-cookie-secret',
                'Heroku-Two-Factor-Code': 'two-factor-secret',
                'X-Heroku-Request-Secret': 'request-header-secret',
                'X-Visible': 'ordinary-header',
              },
            })
          } finally {
            stderr.stop()
          }

          expect(stderr.output).to.contain('POST https://api.heroku.com/debug-secrets')
          expect(stderr.output).to.contain('ordinary-header')
          for (const secret of [
            'request-body-secret',
            'request-cookie-secret',
            'two-factor-secret',
            'request-header-secret',
            'response-body-secret',
            'response-cookie-secret',
            'response-header-secret',
          ]) expect(stderr.output).not.to.contain(secret)
        })

      test
        .it('redacts Particleboard request details while completing the request', async ctx => {
          const pathSecret = 'particleboard-private-path'
          const agentSecret = 'particleboard-agent-secret'
          const requestIdSecret = '00000000-0000-4000-8000-000000000000' as const
          const particleboard = nock('https://particleboard.heroku.com')
            .post(`/${pathSecret}`, {requestSecret: 'particleboard-request-body-secret'})
            .query({token: 'particleboard-query-secret'})
            .reply(200, {responseSecret: 'particleboard-response-body-secret'}, {
              'Request-Id': 'particleboard-response-request-id-secret',
              'Set-Cookie': 'particleboard-response-cookie-secret',
              'X-Heroku-Response-Secret': 'particleboard-response-header-secret',
            })
          const client = new ParticleboardClient(ctx.config)
          client.auth = 'particleboard-token-secret'
          const agent = new Agent()
          Object.assign(agent, {debugSecret: agentSecret})
          const generateRequestId = sinon.stub(RequestId, '_generate').returns(requestIdSecret)
          const httpCallRedact = process.env.HTTP_CALL_REDACT
          process.env.HTTP_CALL_REDACT = '0'
          RequestId.empty()
          debug.enable('http,http:headers')

          stderr.start()
          let response
          try {
            response = await client.http.request(`/${pathSecret}?token=particleboard-query-secret`, {
              agent,
              body: {requestSecret: 'particleboard-request-body-secret'},
              headers: {
                Cookie: 'particleboard-request-cookie-secret',
                'Proxy-Authorization': 'particleboard-proxy-authorization-secret',
                'X-Heroku-Request-Secret': 'particleboard-request-header-secret',
                'X-Visible': 'ordinary-particleboard-header',
              },
              method: 'POST',
            })
          } finally {
            stderr.stop()
            debug.disable()
            generateRequestId.restore()
            agent.destroy()
            if (httpCallRedact === undefined) delete process.env.HTTP_CALL_REDACT
            else process.env.HTTP_CALL_REDACT = httpCallRedact
          }

          expect(response?.body).to.deep.equal({responseSecret: 'particleboard-response-body-secret'})
          expect(stderr.output).to.contain('POST https://particleboard.heroku.com/[redacted]')
          expect(stderr.output).to.contain('ordinary-particleboard-header')
          expect(stderr.output).not.to.contain('proxy:')
          for (const secret of [
            pathSecret,
            agentSecret,
            requestIdSecret,
            'particleboard-query-secret',
            'particleboard-token-secret',
            'particleboard-request-body-secret',
            'particleboard-request-cookie-secret',
            'particleboard-proxy-authorization-secret',
            'particleboard-request-header-secret',
            'particleboard-response-body-secret',
            'particleboard-response-cookie-secret',
            'particleboard-response-header-secret',
            'particleboard-response-request-id-secret',
          ]) expect(stderr.output).not.to.contain(secret)
          particleboard.done()
        })
    })
  })

  context('without HEROKU_DEBUG = "1"', function () {
    context('with HEROKU_DEBUG_HEADERS = "1"', function () {
      test
        .it('doesn\'t enable any HTTP debug info', async ctx => {
          process.env.HEROKU_DEBUG_HEADERS = '1'
          api = nock('https://api.heroku.com', {
            reqheaders: {authorization: 'Bearer mypass'},
          })
          api.get('/apps').reply(200, [{name: 'myapp'}])

          const cmd = new Command([], ctx.config)
          stderr.start()
          await cmd.heroku.get('/apps')
          stderr.stop()

          expect(cmd.heroku.options.debug).to.eq(false)
          expect(cmd.heroku.options.debugHeaders).to.eq(true)
          expect(stderr.output).not.to.contain('GET https://api.heroku.com/apps')
          expect(stderr.output).not.to.contain("accept: 'application/vnd.heroku+json; version=3")
        })
    })

    context('without HEROKU_DEBUG_HEADERS = "1"', function () {
      test
        .it('doesn\'t enable any HTTP debug info', async ctx => {
          api = nock('https://api.heroku.com', {
            reqheaders: {authorization: 'Bearer mypass'},
          })
          api.get('/apps').reply(200, [{name: 'myapp'}])

          const cmd = new Command([], ctx.config)
          stderr.start()
          await cmd.heroku.get('/apps')
          stderr.stop()

          expect(cmd.heroku.options.debug).to.eq(false)
          expect(cmd.heroku.options.debugHeaders).to.eq(false)
          expect(stderr.output).not.to.contain('GET https://api.heroku.com/apps')
          expect(stderr.output).not.to.contain("accept: 'application/vnd.heroku+json; version=3")
        })
    })
  })

  context('with X-Heroku-Warning header set on response', function () {
    test
      .it('shows warnings', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/apps').reply(200, [], {'X-Heroku-Warning': ['Some warning', 'Warning: some other warning']})

        const cmd = new Command([], ctx.config)
        stderr.start()
        await cmd.heroku.get('/apps')
        stderr.stop()

        // Assert that a heading is added to the warning by oclif Error.warn when the message doesn't have a heading.
        expect(stderr.output).to.contain('Warning: Some warning')
        // Assert that a heading is added to the warning by oclif Error.warn but it doesn't get duplicated if it already has a heading.
        expect(stderr.output).to.contain('Warning: some other warning')
        expect(stderr.output).not.to.contain('Warning: Warning: some other warning')
      })

    test
      .it('does not repeat the same warning on subsequent identical responses', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/apps').twice().reply(200, [], {'X-Heroku-Warning': 'Your account password will expire soon.'})

        const cmd = new Command([], ctx.config)
        stderr.start()
        await cmd.heroku.get('/apps')
        await cmd.heroku.get('/apps')
        stderr.stop()

        expect(stderr.output.match(/Warning: Your account password will expire soon\./g)?.length).to.equal(1)
      })

    test
      .it('shows distinct warnings from successive responses', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/apps').twice().reply(200, [], {'X-Heroku-Warning': 'First warning'})
        api.get('/apps/foo').reply(200, [], {'X-Heroku-Warning': 'Second warning'})

        const cmd = new Command([], ctx.config)
        stderr.start()
        await cmd.heroku.get('/apps')
        await cmd.heroku.get('/apps')
        await cmd.heroku.get('/apps/foo')
        stderr.stop()

        expect(stderr.output).to.contain('Warning: First warning')
        expect(stderr.output.match(/Warning: First warning/g)?.length).to.equal(1)
        expect(stderr.output).to.contain('Warning: Second warning')
        expect(stderr.output.match(/Warning: Second warning/g)?.length).to.equal(1)
      })

    test
      .it('shows the same header warning again for a new command instance', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/apps').twice().reply(200, [], {'X-Heroku-Warning': 'Password expiry reminder'})

        const cmd1 = new Command([], ctx.config)
        const cmd2 = new Command([], ctx.config)
        stderr.start()
        await cmd1.heroku.get('/apps')
        await cmd2.heroku.get('/apps')
        stderr.stop()

        expect(stderr.output.match(/Warning: Password expiry reminder/g)?.length).to.equal(2)
      })
  })

  context('with Warning-Message header set on response', function () {
    test
      .it('shows warnings', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/apps').reply(200, [], {'Warning-Message': ['Some warning', 'Warning: some other warning']})

        const cmd = new Command([], ctx.config)
        stderr.start()
        await cmd.heroku.get('/apps')
        stderr.stop()

        // Assert that a heading is added to the warning by oclif Error.warn when the message doesn't have a heading.
        expect(stderr.output).to.contain('Warning: Some warning')
        // Assert that a heading is added to the warning by oclif Error.warn but it doesn't get duplicated if it already has a heading.
        expect(stderr.output).to.contain('Warning: some other warning')
        expect(stderr.output).not.to.contain('Warning: Warning: some other warning')
      })
  })

  context('warning formatting', function () {
    test
      .it('does not add extra newlines to warnings', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/apps').reply(200, [], {'X-Heroku-Warning': 'Test warning message'})

        const cmd = new Command([], ctx.config)
        stderr.start()
        await cmd.heroku.get('/apps')
        stderr.stop()

        // The warning output should contain exactly one newline after the message, not two
        // Two newlines would create a blank line
        const lines = stderr.output.split('\n')
        const warningLineIndex = lines.findIndex(line => line.includes('Test warning message'))
        expect(warningLineIndex).to.be.greaterThan(-1)

        // Check that there isn't an extra blank line after the warning
        // (the next line after warning should be the last empty line from the final newline)
        if (warningLineIndex < lines.length - 2) {
          const nextLine = lines[warningLineIndex + 1]
          // The line immediately after warning should be the final empty string from split
          // If it has content (even just whitespace/›), that means there's an extra newline
          expect(nextLine.trim()).to.equal('')
        }
      })
  })

  context('request ids', function () {
    let generateStub: any

    beforeEach(function () {
      RequestId.empty()
      generateStub = sinon.stub(RequestId, '_generate')
    })

    afterEach(function () {
      generateStub.restore()
    })

    test
      .it('makes requests with a generated request id', async ctx => {
        const cmd = new Command([], ctx.config)

        generateStub.returns('random-uuid')
        api = nock('https://api.heroku.com').get('/apps').reply(200, [{name: 'myapp'}])

        const {request} = await cmd.heroku.get('/apps')
        expect(request.getHeader(requestIdHeader)).to.deep.equal('random-uuid')
      })

    test
      .it('makes requests including previous request ids', async ctx => {
        const cmd = new Command([], ctx.config)
        api = nock('https://api.heroku.com').get('/apps').twice().reply(200, [{name: 'myapp'}])

        generateStub.returns('random-uuid')
        await cmd.heroku.get('/apps')

        generateStub.returns('second-random-uuid')
        const {request: secondRequest} = await cmd.heroku.get('/apps')

        expect(secondRequest.getHeader(requestIdHeader)).to.deep.equal('second-random-uuid,random-uuid')
      })

    test
      .it('tracks response request ids for subsequent request ids', async ctx => {
        const cmd = new Command([], ctx.config)
        const existingRequestIds = ['first-existing-request-id', 'second-existing-request-id'].join(',')
        api = nock('https://api.heroku.com')
          .get('/apps')
          .twice()
          .reply(() => [200, JSON.stringify({name: 'myapp'}), {[requestIdHeader]: existingRequestIds}])

        generateStub.returns('random-uuid')
        await cmd.heroku.get('/apps')

        generateStub.returns('second-random-uuid')
        const {request: secondRequest} = await cmd.heroku.get('/apps')

        expect(secondRequest.getHeader(requestIdHeader)).to.deep.equal('second-random-uuid,first-existing-request-id,second-existing-request-id,random-uuid')
      })

    test
      .it('resets request id when it exceeds 7KB', async ctx => {
        const cmd = new Command([], ctx.config)
        // Create a large request ID that exceeds 7KB
        const largeRequestId = 'x'.repeat(1024 * 8)
        Reflect.set(RequestId, 'ids', [largeRequestId])

        generateStub.returns('new-uuid-after-reset')
        api = nock('https://api.heroku.com').get('/apps').reply(200, [{name: 'myapp'}])

        const {request} = await cmd.heroku.get('/apps')
        expect(request.getHeader(requestIdHeader)).to.deep.equal(['new-uuid-after-reset'])
      })

    test
      .it('keeps existing request id when under 7KB', async ctx => {
        const cmd = new Command([], ctx.config)
        // Create a request ID that's under 7KB
        const normalRequestId = 'normal-request-id'
        Reflect.set(RequestId, 'ids', [normalRequestId])

        api = nock('https://api.heroku.com').get('/apps').reply(200, [{name: 'myapp'}])

        const {request} = await cmd.heroku.get('/apps')
        expect(request.getHeader(requestIdHeader)).to.deep.equal(',normal-request-id')
      })
  })
})
