import {Config} from '@oclif/core/config'
import debug from 'debug'
import {expect, fancy} from 'fancy-test'
import nock from 'nock'
import * as fs from 'node:fs'
import * as os from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import * as sinon from 'sinon'
import {stderr} from 'stdout-stderr'

const SYSTEM_TMPDIR = os.tmpdir()

import {Command as CommandBase} from '../src/command.js'
import {writeLoginState} from '../src/credential-manager-core/lib/login-state.js'
import {setCredentialManagerProvider} from '../src/credential-manager.js'
import {RequestId, requestIdHeader} from '../src/request-id.js'
import {restoreCredentialManagerStub, stubCredentialManager} from './helpers/credential-manager-stub.js'

class Command extends CommandBase {
  async run() {}
}

const {env} = process
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
        api.get('/oauth/authorizations/~').reply(200, {})

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
        api.get('/account').reply(401, {id: 'unauthorized'})
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
      platformStub = sinon.stub(process, 'platform').value('darwin')
      process.env.HEROKU_NATIVE_STORE_WRITE = 'true'
    })

    afterEach(() => {
      fs.rmSync(tmpDir, {force: true, recursive: true})
      delete process.env.HEROKU_NATIVE_STORE_WRITE
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
        api.get('/oauth/authorizations/~').reply(200, {})
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
        expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.false
      })

    test
      .it('returns undefined without querying credential store when login.json is missing', async ctx => {
        let getAuthCalled = false
        setCredentialManagerProvider({
          async getAuth() {
            getAuthCalled = true
            return {account: 'should-not-use@example.com', token: 'should-not-use'}
          },
          async removeAuth() {},
          async saveAuth() {},
        })
        const cmd = new Command([], ctx.config)
        cmd.config = {...ctx.config, dataDir: tmpDir} as Config
        const result = await cmd.heroku.getAuthEntry()
        expect(result).to.be.undefined
        expect(getAuthCalled).to.be.false
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
    const removeAuthCalls: {account: string | undefined; hosts: string[]}[] = []

    beforeEach(() => {
      removeAuthCalls.length = 0
      setCredentialManagerProvider({
        async getAuth() {
          return {account: 'logout@example.com', token: 'logout-test-token'}
        },
        async removeAuth(account: string | undefined, hosts: string[]) {
          removeAuthCalls.push({account, hosts})
        },
        async saveAuth() {},
      })
      api.delete('/oauth/sessions/~').reply(200, {})
      api.get('/oauth/authorizations').reply(200, [])
      api.get('/oauth/authorizations/~').reply(200, {})
    })

    afterEach(() => {
      delete process.env.HEROKU_API_KEY
    })

    test
      .it('calls removeAuth with api and git hosts after revoking session', async ctx => {
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        await cmd.heroku.logout()
        expect(removeAuthCalls).to.have.length(1)
        expect(removeAuthCalls[0].account).to.equal('logout@example.com')
        expect(removeAuthCalls[0].hosts).to.deep.equal(['api.heroku.com', 'git.heroku.com'])
        expect(cmd.heroku.auth).to.be.undefined
      })

    test
      .it('calls removeAuth with undefined account when HEROKU_API_KEY is set', async ctx => {
        process.env.HEROKU_API_KEY = 'env-api-key'
        removeAuthCalls.length = 0
        const cmd = new Command([], ctx.config)
        cmd.config = ctx.config
        await cmd.heroku.logout()
        expect(removeAuthCalls).to.have.length(1)
        expect(removeAuthCalls[0].account).to.be.undefined
        expect(removeAuthCalls[0].hosts).to.deep.equal(['api.heroku.com', 'git.heroku.com'])
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
        api.get('/account').reply(401, {id: 'unauthorized'})

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
        particleboard.get('/account').reply(401, {id: 'unauthorized', message: 'Unauthorized'})

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
      scope.put('/apps/myapp/pre-authorizations').reply(200, {})
      scope.get('/apps/myapp').reply(200, {name: 'myapp'})
      scope.get('/apps/anotherapp').reply(200, {name: 'anotherapp'})
      scope.get('/apps/myapp/config').reply(200, {foo: 'bar'})
      scope.get('/apps/myapp/dynos').reply(200, {web: 1})

      const cmd = new Command([], ctx.config)
      // Mock the twoFactorPrompt method
      sinon.stub(cmd.heroku, 'twoFactorPrompt').resolves('123456')
      const info = cmd.heroku.get('/apps/myapp')
      const anotherapp = cmd.heroku.get('/apps/anotherapp')
      const _config = cmd.heroku.get('/apps/myapp/config')
      const dynos = cmd.heroku.get('/apps/myapp/dynos')
      expect((await info).body).to.deep.equal({name: 'myapp'})
      expect((await anotherapp).body).to.deep.equal({name: 'anotherapp'})
      expect((await _config).body).to.deep.equal({foo: 'bar'})
      expect((await dynos).body).to.deep.equal({web: 1})
      scope.done()
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
