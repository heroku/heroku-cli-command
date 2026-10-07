import {Config} from '@oclif/core/config'
import {ux} from '@oclif/core/ux'
import {expect as chaiExpect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'
import debug from 'debug'
import {expect, fancy} from 'fancy-test'
import nock from 'nock'
import * as fs from 'node:fs'
import * as os from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import * as sinon from 'sinon'
import {stderr} from 'stdout-stderr'

import {Command as CommandBase} from '../src/command.js'
import {readLoginState, writeLoginState} from '../src/credential-manager-core/lib/login-state.js'
import {setCredentialManagerProvider} from '../src/credential-manager.js'
import {writeLoginStateCoordinated} from '../src/login-state-coordinator.js'
import {prompter} from '../src/prompter.js'
import {RequestId, requestIdHeader} from '../src/request-id.js'
import {restoreCredentialManagerStub, stubCredentialManager} from './helpers/credential-manager-stub.js'

const SYSTEM_TMPDIR = os.tmpdir()
const TEST_PLATFORM = process.platform === 'win32' ? 'win32' : 'darwin'

use(chaiAsPromised)

class Command extends CommandBase {
  async run() {}
}

const {env} = process
let api: nock.Scope
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
function deferred<T = void>() {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: PromiseLike<T> | T) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise
    resolve = resolvePromise
  })
  return {promise, reject, resolve}
}

const test = fancy
  .add('config', () => {
    const config = new Config({root: resolve(__dirname, '../package.json')})
    return config
  })
// const test = base.add('config', new Config({root: resolve(__dirname, '../package.json')}))

describe('api_client', () => {
  beforeEach(function () {
    nock.cleanAll()
    process.env = {}
    debug.disable()
    api = nock('https://api.heroku.com')
    stubCredentialManager()
  })

  afterEach(function () {
    process.env = env
    api.done()
    restoreCredentialManagerStub()
  })

  describe('getAuthEntry', () => {
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
      .it('does not let a delayed credential read overwrite a newer auth entry', async ctx => {
        const lookupStarted = deferred()
        const releaseLookup = deferred()
        setCredentialManagerProvider({
          async getAuth() {
            lookupStarted.resolve()
            await releaseLookup.promise
            return {account: 'stale@example.com', token: 'stale-token'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config

        const staleRead = cmd.heroku.getAuthEntry()
        await lookupStarted.promise
        cmd.heroku.setAuthEntry({account: 'new@example.com', token: 'new-token'})
        releaseLookup.resolve()

        expect(await staleRead).to.deep.equal({account: 'stale@example.com', token: 'stale-token'})
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'new@example.com', token: 'new-token'})
        expect(cmd.heroku.auth).to.equal('new-token')
      })

    test
      .it('does not let a delayed missing-credential read clear newer auth resolution state', async ctx => {
        const lookupStarted = deferred()
        const releaseLookup = deferred()
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            if (getCalls === 1) {
              lookupStarted.resolve()
              await releaseLookup.promise
              throw new Error('No auth found')
            }

            return {account: 'stored@example.com', token: 'stored-token'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config

        const staleRead = cmd.heroku.getAuthEntry()
        await lookupStarted.promise
        cmd.heroku.setAuthEntry({account: 'new@example.com', token: 'new-token'})
        releaseLookup.resolve()

        expect(await staleRead).to.be.undefined
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'new@example.com', token: 'new-token'})
        cmd.heroku.setAuthEntry(undefined)
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'stored@example.com', token: 'stored-token'})
        expect(getCalls).to.equal(2)
      })

    test
      .it('does not let a stale read clear the current generation in-flight dedupe promise', async ctx => {
        const firstStarted = deferred()
        const secondStarted = deferred()
        const releaseFirst = deferred()
        const releaseSecond = deferred()
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            if (getCalls === 1) {
              firstStarted.resolve()
              await releaseFirst.promise
              return {account: 'stale@example.com', token: 'stale-token'}
            }

            secondStarted.resolve()
            await releaseSecond.promise
            return {account: 'current@example.com', token: 'current-token'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config

        const staleRead = cmd.heroku.getAuthEntry()
        await firstStarted.promise
        cmd.heroku.setAuthEntry(undefined)
        const currentRead = cmd.heroku.getAuthEntry()
        await secondStarted.promise
        releaseFirst.resolve()
        await staleRead
        const dedupedCurrentRead = cmd.heroku.getAuthEntry()
        releaseSecond.resolve()

        const expected = {account: 'current@example.com', token: 'current-token'}
        expect(await currentRead).to.deep.equal(expected)
        expect(await dedupedCurrentRead).to.deep.equal(expected)
        expect(getCalls).to.equal(2)
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
      .it('treats the exact current-host missing-auth error as normal absence', async ctx => {
        setCredentialManagerProvider({
          async getAuth() {
            throw new Error('No auth found for api.heroku.com')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config

        expect(await cmd.heroku.getAuthEntry()).to.be.undefined
      })

    test
      .it('surfaces other No auth errors as operational failures', async ctx => {
        const operationalFailure = new Error('No auth backend available')
        setCredentialManagerProvider({
          async getAuth() {
            throw operationalFailure
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config

        expect(await cmd.heroku.getAuthEntry().catch((error: unknown) => error)).to.equal(operationalFailure)
      })

    test
      .it('uses the host-specific credential service for a custom HEROKU_HOST lookup', async ctx => {
        process.env.HEROKU_HOST = 'staging.heroku.com'
        let receivedService: string | undefined
        setCredentialManagerProvider({
          async getAuth(_account, _host, service) {
            receivedService = service
            return {account: 'custom@example.com', token: 'custom-token'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config

        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'custom@example.com', token: 'custom-token'})
        expect(receivedService).to.equal('heroku-cli@api.staging.heroku.com')
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
  })

  describe('login state file integration', () => {
    let tmpDir: string
    let platformStub: sinon.SinonStub

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(join(SYSTEM_TMPDIR, 'heroku-api-client-'))
      platformStub = sinon.stub(process, 'platform').value(TEST_PLATFORM)
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
        await (cmd.heroku as unknown as {_authLifecycle: Promise<void>})._authLifecycle
        expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.false
      })

    test
      .it('surfaces credential backend failures without deleting login.json or caching absence', async ctx => {
        const backendFailure = Object.assign(new Error('security process failed'), {code: 'EACCES'})
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            if (getCalls === 1) throw backendFailure
            return {account: 'cached@example.com', token: 'recovered-token'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        await writeLoginState(tmpDir, 'cached@example.com')
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config

        const error = await cmd.heroku.getAuthEntry().catch((error: unknown) => error)

        expect(error).to.equal(backendFailure)
        expect(await readLoginState(tmpDir)).to.deep.equal({account: 'cached@example.com'})
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'cached@example.com', token: 'recovered-token'})
        expect(getCalls).to.equal(2)
      })

    test
      .it('clears malformed login.json when credential lookup also fails', async ctx => {
        setCredentialManagerProvider({
          async getAuth() {
            throw new Error('No auth found')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        fs.writeFileSync(join(tmpDir, 'login.json'), '{malformed')
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config

        await cmd.heroku.getAuthEntry()
        await (cmd.heroku as unknown as {_authLifecycle: Promise<void>})._authLifecycle

        expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.false
      })

    test
      .it('finishes stale login-state cleanup before a newer login writes login.json', async ctx => {
        const deleteStarted = deferred()
        const loginWriteFinished = deferred()
        const releaseDelete = deferred()
        const originalUnlink = fs.promises.unlink.bind(fs.promises)
        const unlink = sinon.stub(fs.promises, 'unlink').callsFake(async path => {
          deleteStarted.resolve()
          await releaseDelete.promise
          return originalUnlink(path)
        })
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
        const facade = (cmd.heroku as unknown as {
          _login: {login(): Promise<void>};
        })._login
        const login = sinon.stub(facade, 'login').callsFake(async () => {
          await writeLoginStateCoordinated(tmpDir, 'new@example.com')
          cmd.heroku.setAuthEntry({account: 'new@example.com', token: 'new-token'})
          loginWriteFinished.resolve()
        })

        try {
          const staleRead = cmd.heroku.getAuthEntry()
          await deleteStarted.promise
          const newLogin = cmd.heroku.login()
          await Promise.resolve()
          if (login.called) await loginWriteFinished.promise
          releaseDelete.resolve()
          await Promise.all([staleRead, newLogin])

          expect(await readLoginState(tmpDir)).to.deep.equal({account: 'new@example.com'})
          expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'new@example.com', token: 'new-token'})
        } finally {
          unlink.restore()
        }
      })

    test
      .it('does not unlink a newer package-coordinated login state after stale validation', async ctx => {
        const deleteStarted = deferred()
        const releaseDelete = deferred()
        const originalUnlink = fs.promises.unlink.bind(fs.promises)
        const unlink = sinon.stub(fs.promises, 'unlink').callsFake(async path => {
          deleteStarted.resolve()
          await releaseDelete.promise
          return originalUnlink(path)
        })
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
        const {_login} = cmd.heroku as unknown as {
          _login: {createDelegate(): {storage: {writeLoginState(dataDir: string, account: string): Promise<void>}}};
        }
        const {storage} = _login.createDelegate()

        try {
          const staleRead = cmd.heroku.getAuthEntry()
          await deleteStarted.promise
          let newerWriteFinished = false
          const newerWrite = storage.writeLoginState(tmpDir, 'new@example.com').then(() => {
            newerWriteFinished = true
            cmd.heroku.setAuthEntry({account: 'new@example.com', token: 'new-token'})
          })
          await Promise.resolve()

          expect(newerWriteFinished).to.equal(false)
          expect(await readLoginState(tmpDir)).to.deep.equal({account: 'stale@example.com'})
          releaseDelete.resolve()
          await Promise.all([staleRead, newerWrite])
          await (cmd.heroku as unknown as {_authLifecycle: Promise<void>})._authLifecycle

          expect(await readLoginState(tmpDir)).to.deep.equal({account: 'new@example.com'})
          expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'new@example.com', token: 'new-token'})
        } finally {
          releaseDelete.resolve()
          unlink.restore()
        }
      })

    for (const [description, newerAccount] of [
      ['same-account', 'same@example.com'],
      ['different-account', 'different@example.com'],
    ] as const) {
      test
        .it(`keeps a newer ${description} write from another APIClient when stale cleanup enters later`, async ctx => {
          const lookupStarted = deferred()
          const releaseLookup = deferred()
          setCredentialManagerProvider({
            async getAuth() {
              lookupStarted.resolve()
              await releaseLookup.promise
              throw new Error('No auth found')
            },
            async removeAuth() {},
            async saveAuth() {},
          })
          await writeLoginStateCoordinated(tmpDir, 'same@example.com')
          const staleCommand = new Command([], ctx.config)
          staleCommand.config = {...ctx.config, dataDir: tmpDir} as Config
          const newerCommand = new Command([], ctx.config)
          newerCommand.config = {...ctx.config, dataDir: tmpDir} as Config
          const {_login} = newerCommand.heroku as unknown as {
            _login: {createDelegate(): {storage: {writeLoginState(dataDir: string, account: string): Promise<void>}}};
          }
          const {storage} = _login.createDelegate()

          const staleRead = staleCommand.heroku.getAuthEntry()
          await lookupStarted.promise
          await storage.writeLoginState(tmpDir, newerAccount)
          newerCommand.heroku.setAuthEntry({account: newerAccount, token: 'new-token'})
          releaseLookup.resolve()
          await staleRead
          await (staleCommand.heroku as unknown as {_authLifecycle: Promise<void>})._authLifecycle

          expect(await readLoginState(tmpDir)).to.deep.equal({account: newerAccount})
          expect(await newerCommand.heroku.getAuthEntry()).to.deep.equal({account: newerAccount, token: 'new-token'})
        })
    }

    test
      .it('lets a real login finish when it dedupes an external failed credential read', async ctx => {
        const lookupStarted = deferred()
        const releaseLookup = deferred()
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            lookupStarted.resolve()
            await releaseLookup.promise
            throw new Error('No auth found')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        await writeLoginState(tmpDir, 'stale@example.com')
        const prompt = sinon.stub(prompter, 'prompt').callsFake(async questions => {
          const [question] = questions
          return question.name === 'email'
            ? {email: 'new@example.com'}
            : {password: 'password'}
        })
        const oauthStarted = deferred()
        api.post('/oauth/authorizations').reply(() => {
          oauthStarted.resolve()
          return [200, {access_token: {token: 'new-token'}, user: {email: 'new@example.com'}}]
        })
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config

        const externalRead = cmd.heroku.getAuthEntry()
        await lookupStarted.promise
        const login = cmd.heroku.login({method: 'interactive'})
        releaseLookup.resolve()
        const reachedOAuth = await Promise.race([
          oauthStarted.promise.then(() => true),
          new Promise<false>(resolve => {
            setTimeout(() => resolve(false), 250)
          }),
        ])

        expect(reachedOAuth).to.be.true
        await Promise.all([externalRead, login])
        expect(getCalls).to.equal(2)
        expect(prompt.called).to.be.true
        expect(await readLoginState(tmpDir)).to.deep.equal({account: 'new@example.com'})
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'new@example.com', token: 'new-token'})
      })

    test
      .it('does not let detached work from a completed transaction bypass the current queue owner', async ctx => {
        const triggerDetachedRead = deferred()
        const detachedReadStarted = deferred()
        const detachedReadFinished = deferred()
        const currentLoginStarted = deferred()
        const releaseCurrentLogin = deferred()
        const unlink = sinon.stub(fs.promises, 'unlink').resolves()
        setCredentialManagerProvider({
          async getAuth() {
            detachedReadStarted.resolve()
            throw new Error('No auth found')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        await writeLoginState(tmpDir, 'stale@example.com')
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config
        const facade = (cmd.heroku as unknown as {
          _login: {login(): Promise<void>};
        })._login
        const login = sinon.stub(facade, 'login')
        login.onFirstCall().callsFake(async () => {
          setImmediate(async () => {
            await triggerDetachedRead.promise
            await cmd.heroku.getAuthEntry()
            detachedReadFinished.resolve()
          })
        })
        login.onSecondCall().callsFake(async () => {
          currentLoginStarted.resolve()
          await releaseCurrentLogin.promise
        })

        try {
          await cmd.heroku.login()
          const currentLogin = cmd.heroku.login()
          await currentLoginStarted.promise
          triggerDetachedRead.resolve()
          await detachedReadStarted.promise
          await detachedReadFinished.promise
          await new Promise(resolve => {
            setImmediate(resolve)
          })

          expect(unlink.called).to.be.false
          releaseCurrentLogin.resolve()
          await currentLogin
          await (cmd.heroku as unknown as {_authLifecycle: Promise<void>})._authLifecycle
          expect(unlink.calledOnce).to.be.true
        } finally {
          releaseCurrentLogin.resolve()
          unlink.restore()
        }
      })

    test
      .it('keeps credential lookup failure nonfatal when stale login-state cleanup fails', async ctx => {
        const cleanupFailure = Object.assign(new Error('cleanup denied'), {code: 'EACCES'})
        const unlink = sinon.stub(fs.promises, 'unlink').rejects(cleanupFailure)
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

        try {
          expect(await cmd.heroku.getAuthEntry()).to.be.undefined
          await (cmd.heroku as unknown as {_authLifecycle: Promise<void>})._authLifecycle
          expect(await readLoginState(tmpDir)).to.deep.equal({account: 'stale@example.com'})
        } finally {
          unlink.restore()
        }
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

  describe('auth lifecycle serialization', () => {
    type LoginFacade = {
      login(options?: unknown): Promise<void>;
      logoutEntry(entry: {account: string; token: string}): Promise<void>;
    }

    function facade(cmd: Command): LoginFacade {
      return (cmd.heroku as unknown as {_login: LoginFacade})._login
    }

    test
      .it('completes logout before a subsequently invoked login and preserves the later login state', async ctx => {
        const logoutStarted = deferred()
        const releaseLogout = deferred()
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        cmd.heroku.setAuthEntry({account: 'old@example.com', token: 'old-token'})
        const logoutEntry = sinon.stub(facade(cmd), 'logoutEntry').callsFake(async () => {
          logoutStarted.resolve()
          await releaseLogout.promise
        })
        const login = sinon.stub(facade(cmd), 'login').callsFake(async () => {
          cmd.heroku.setAuthEntry({account: 'new@example.com', token: 'new-token'})
        })

        const logoutResult = cmd.heroku.logout()
        await logoutStarted.promise
        const loginResult = cmd.heroku.login()
        await Promise.resolve()

        expect(login.called).to.be.false
        releaseLogout.resolve()
        await Promise.all([logoutResult, loginResult])

        expect(logoutEntry.calledOnceWithExactly({account: 'old@example.com', token: 'old-token'})).to.be.true
        expect(login.calledOnce).to.be.true
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'new@example.com', token: 'new-token'})
      })

    test
      .it('completes login before a subsequently invoked logout and logs out the resulting entry', async ctx => {
        const loginStarted = deferred()
        const releaseLogin = deferred()
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        cmd.heroku.setAuthEntry({account: 'old@example.com', token: 'old-token'})
        const login = sinon.stub(facade(cmd), 'login').callsFake(async () => {
          loginStarted.resolve()
          await releaseLogin.promise
          cmd.heroku.setAuthEntry({account: 'new@example.com', token: 'new-token'})
        })
        const logoutEntry = sinon.stub(facade(cmd), 'logoutEntry').resolves()

        const loginResult = cmd.heroku.login()
        await loginStarted.promise
        const logoutResult = cmd.heroku.logout()
        await Promise.resolve()

        expect(logoutEntry.called).to.be.false
        releaseLogin.resolve()
        await Promise.all([loginResult, logoutResult])

        expect(login.calledOnce).to.be.true
        expect(logoutEntry.calledOnceWithExactly({account: 'new@example.com', token: 'new-token'})).to.be.true
        expect(cmd.heroku.auth).to.be.undefined
      })

    test
      .it('recovers the lifecycle queue after a failed login', async ctx => {
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        cmd.heroku.setAuthEntry({account: 'old@example.com', token: 'old-token'})
        const loginFailure = new Error('login failed')
        sinon.stub(facade(cmd), 'login').rejects(loginFailure)
        const logoutEntry = sinon.stub(facade(cmd), 'logoutEntry').resolves()

        const loginError = await cmd.heroku.login().catch((error: unknown) => error)
        await cmd.heroku.logout()

        expect(loginError).to.equal(loginFailure)
        expect(logoutEntry.calledOnceWithExactly({account: 'old@example.com', token: 'old-token'})).to.be.true
        expect(cmd.heroku.auth).to.be.undefined
      })
  })

  describe('logout', () => {
    const removeAuthCalls: {
      account: string | undefined;
      expectedToken: string | undefined;
      hosts: string[];
      service: string | undefined;
    }[] = []

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
      api.delete('/oauth/sessions/~').reply(200, {})
      api.get('/oauth/authorizations').reply(200, [])
      api.get('/oauth/authorizations/~').reply(404, {
        id: 'not_found',
        resource: 'authorization',
      })
    })

    afterEach(() => {
      delete process.env.HEROKU_API_KEY
    })

    test
      .it('delegates complete logout cleanup once with the snapshot token', async ctx => {
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        await cmd.heroku.logout()
        expect(removeAuthCalls).to.have.length(1)
        expect(removeAuthCalls[0]).to.deep.equal({
          account: 'logout@example.com',
          expectedToken: 'logout-test-token',
          hosts: ['api.heroku.com', 'git.heroku.com'],
          service: 'heroku-cli',
        })
        expect(cmd.heroku.auth).to.be.undefined
      })

    test
      .it('revokes an account-less HEROKU_API_KEY and unconditionally cleans persistent hosts', async ctx => {
        process.env.HEROKU_API_KEY = 'env-api-key'
        removeAuthCalls.length = 0
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        await cmd.heroku.logout()
        expect(removeAuthCalls).to.deep.equal([{
          account: undefined,
          expectedToken: 'env-api-key',
          hosts: ['api.heroku.com', 'git.heroku.com'],
          service: 'heroku-cli',
        }])
        expect(cmd.heroku.auth).to.be.undefined
      })

    test
      .it('revokes legacy token-only state and unconditionally cleans persistent hosts', async ctx => {
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        cmd.heroku.setAuthEntry({account: undefined, token: 'legacy-token'})

        await cmd.heroku.logout()

        expect(removeAuthCalls).to.deep.equal([{
          account: undefined,
          expectedToken: 'legacy-token',
          hosts: ['api.heroku.com', 'git.heroku.com'],
          service: 'heroku-cli',
        }])
        expect(cmd.heroku.auth).to.be.undefined
      })

    test
      .it('cleans account-less hosts but preserves unrelated login state when remote revocation fails', async ctx => {
        nock.cleanAll()
        api = nock('https://api.heroku.com')
        api.delete('/oauth/sessions/~').reply(500, {id: 'server_error', message: 'remote failed'})
        api.get('/oauth/authorizations').reply(200, [])
        api.get('/oauth/authorizations/~').reply(404, {
          id: 'not_found',
          resource: 'authorization',
        })
        const tmpDir = fs.mkdtempSync(join(SYSTEM_TMPDIR, 'heroku-api-client-token-logout-'))
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config
        cmd.heroku.setAuthEntry({account: undefined, token: 'legacy-token'})
        await writeLoginState(tmpDir, 'stale@example.com')

        try {
          await cmd.heroku.logout()

          expect(removeAuthCalls).to.deep.equal([{
            account: undefined,
            expectedToken: 'legacy-token',
            hosts: ['api.heroku.com', 'git.heroku.com'],
            service: 'heroku-cli',
          }])
          expect(await readLoginState(tmpDir)).to.deep.equal({account: 'stale@example.com'})
        } finally {
          fs.rmSync(tmpDir, {force: true, recursive: true})
        }
      })

    test
      .it('uses the host-specific credential service for custom-host token-only cleanup', async ctx => {
        nock.cleanAll()
        process.env.HEROKU_HOST = 'staging.heroku.com'
        api = nock('https://api.staging.heroku.com')
        api.delete('/oauth/sessions/~').reply(200, {})
        api.get('/oauth/authorizations').reply(200, [])
        api.get('/oauth/authorizations/~').reply(404, {id: 'not_found', resource: 'authorization'})
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        cmd.heroku.setAuthEntry({account: undefined, token: 'custom-host-token'})

        await cmd.heroku.logout()

        expect(removeAuthCalls).to.deep.equal([{
          account: undefined,
          expectedToken: 'custom-host-token',
          hosts: ['api.staging.heroku.com', 'git.staging.heroku.com'],
          service: 'heroku-cli@api.staging.heroku.com',
        }])
      })

    test
      .it('resets memory and allows a storage re-read after remote logout failure', async ctx => {
        nock.cleanAll()
        api = nock('https://api.heroku.com')
        api.delete('/oauth/sessions/~').reply(500, {id: 'server_error', message: 'remote failed'})
        api.get('/oauth/authorizations').reply(200, [])
        api.get('/oauth/authorizations/~').reply(404, {
          id: 'not_found',
          resource: 'authorization',
        })
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            return getCalls === 1
              ? {account: 'logout@example.com', token: 'logout-test-token'}
              : {account: 'replacement@example.com', token: 'replacement-token'}
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
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config

        stderr.start()
        try {
          await cmd.heroku.logout()
        } finally {
          stderr.stop()
        }

        expect(stderr.output).to.contain('Error: remote failed')
        expect(cmd.heroku.auth).to.be.undefined
        expect(await cmd.heroku.getAuthEntry()).to.deep.equal({
          account: 'replacement@example.com',
          token: 'replacement-token',
        })
        expect(getCalls).to.equal(2)
      })

    test
      .it('resets memory and suppresses local cleanup failure after remote success', async ctx => {
        const localFailure = new Error('local cleanup failed')
        setCredentialManagerProvider({
          async getAuth() {
            return {account: 'logout@example.com', token: 'logout-test-token'}
          },
          async removeAuth() {
            throw localFailure
          },
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config

        stderr.start()
        const result = await cmd.heroku.logout()
        stderr.stop()

        expect(result).to.be.undefined
        expect(stderr.output).to.equal('')
        expect(cmd.heroku.auth).to.be.undefined
      })

    test
      .it('suppresses package local-failure precedence when local and remote logout both fail', async ctx => {
        nock.cleanAll()
        api = nock('https://api.heroku.com')
        api.delete('/oauth/sessions/~').reply(500, {id: 'server_error', message: 'remote failed'})
        api.get('/oauth/authorizations').reply(200, [])
        api.get('/oauth/authorizations/~').reply(404, {
          id: 'not_found',
          resource: 'authorization',
        })
        const localFailure = new Error('local cleanup won')
        setCredentialManagerProvider({
          async getAuth() {
            return {account: 'logout@example.com', token: 'logout-test-token'}
          },
          async removeAuth() {
            throw localFailure
          },
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config

        const result = await cmd.heroku.logout()

        expect(result).to.be.undefined
        expect(cmd.heroku.auth).to.be.undefined
      })

    test
      .it('keeps no-token logout a no-op and resets missing-auth resolution', async ctx => {
        nock.cleanAll()
        api = nock('https://api.heroku.com')
        let getCalls = 0
        setCredentialManagerProvider({
          async getAuth() {
            getCalls++
            throw new Error('No auth found')
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
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config

        await cmd.heroku.logout()
        expect(await cmd.heroku.getAuthEntry()).to.be.undefined

        expect(removeAuthCalls).to.have.length(0)
        expect(getCalls).to.equal(2)
      })

    test
      .it('lets no-token logout preserve queued cleanup for stale login.json', async ctx => {
        nock.cleanAll()
        api = nock('https://api.heroku.com')
        const tmpDir = fs.mkdtempSync(join(SYSTEM_TMPDIR, 'heroku-api-client-no-token-'))
        const platformStub = sinon.stub(process, 'platform').value(TEST_PLATFORM)
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

        try {
          await cmd.heroku.logout()
          await (cmd.heroku as unknown as {_authLifecycle: Promise<void>})._authLifecycle

          expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.false
          expect(cmd.heroku.auth).to.be.undefined
        } finally {
          platformStub.restore()
          fs.rmSync(tmpDir, {force: true, recursive: true})
        }
      })

    test
      .it('lets no-token logout preserve queued cleanup for malformed login.json', async ctx => {
        nock.cleanAll()
        api = nock('https://api.heroku.com')
        const tmpDir = fs.mkdtempSync(join(SYSTEM_TMPDIR, 'heroku-api-client-no-token-'))
        const platformStub = sinon.stub(process, 'platform').value(TEST_PLATFORM)
        setCredentialManagerProvider({
          async getAuth() {
            throw new Error('No auth found')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        fs.writeFileSync(join(tmpDir, 'login.json'), '{malformed')
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config

        try {
          await cmd.heroku.logout()
          await (cmd.heroku as unknown as {_authLifecycle: Promise<void>})._authLifecycle

          expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.false
        } finally {
          platformStub.restore()
          fs.rmSync(tmpDir, {force: true, recursive: true})
        }
      })

    test
      .it('keeps no-token logout with no login state a clean no-op', async ctx => {
        nock.cleanAll()
        api = nock('https://api.heroku.com')
        const tmpDir = fs.mkdtempSync(join(SYSTEM_TMPDIR, 'heroku-api-client-no-token-'))
        const platformStub = sinon.stub(process, 'platform').value(TEST_PLATFORM)
        const unlink = sinon.spy(fs.promises, 'unlink')
        setCredentialManagerProvider({
          async getAuth() {
            throw new Error('No auth found')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config

        try {
          await cmd.heroku.logout()
          await (cmd.heroku as unknown as {_authLifecycle: Promise<void>})._authLifecycle

          expect(unlink.called).to.be.false
          expect(cmd.heroku.auth).to.be.undefined
        } finally {
          unlink.restore()
          platformStub.restore()
          fs.rmSync(tmpDir, {force: true, recursive: true})
        }
      })

    test
      .it('keeps newer auth and login state when no-token logout cleanup becomes stale', async ctx => {
        nock.cleanAll()
        api = nock('https://api.heroku.com')
        const tmpDir = fs.mkdtempSync(join(SYSTEM_TMPDIR, 'heroku-api-client-no-token-'))
        const platformStub = sinon.stub(process, 'platform').value(TEST_PLATFORM)
        const lookupStarted = deferred()
        const releaseLookup = deferred()
        setCredentialManagerProvider({
          async getAuth() {
            lookupStarted.resolve()
            await releaseLookup.promise
            throw new Error('No auth found')
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        await writeLoginState(tmpDir, 'stale@example.com')
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config

        try {
          const logout = cmd.heroku.logout()
          await lookupStarted.promise
          await writeLoginState(tmpDir, 'new@example.com')
          cmd.heroku.setAuthEntry({account: 'new@example.com', token: 'new-token'})
          releaseLookup.resolve()
          await logout
          await (cmd.heroku as unknown as {_authLifecycle: Promise<void>})._authLifecycle

          expect(await readLoginState(tmpDir)).to.deep.equal({account: 'new@example.com'})
          expect(await cmd.heroku.getAuthEntry()).to.deep.equal({account: 'new@example.com', token: 'new-token'})
        } finally {
          releaseLookup.resolve()
          platformStub.restore()
          fs.rmSync(tmpDir, {force: true, recursive: true})
        }
      })
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
  })

  describe('request for Account Info endpoint', () => {
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
          process.env = {
            HEROKU_DEBUG: '1',
          }
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
          process.env = {
            HEROKU_DEBUG: '1',
            HEROKU_DEBUG_HEADERS: '1',
          }
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
    })
  })

  context('without HEROKU_DEBUG = "1"', function () {
    context('with HEROKU_DEBUG_HEADERS = "1"', function () {
      test
        .it('doesn\'t enable any HTTP debug info', async ctx => {
          process.env = {
            HEROKU_DEBUG_HEADERS: '1',
          }
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
