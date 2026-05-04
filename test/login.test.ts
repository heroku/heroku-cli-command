import {Config} from '@oclif/core/config'
import {ux} from '@oclif/core/ux'
import ansis from 'ansis'
import {expect, fancy} from 'fancy-test'
import nock from 'nock'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import * as sinon from 'sinon'

import {Command as CommandBase} from '../src/command.js'
import {setCredentialManagerProvider} from '../src/credential-manager.js'
import {Login} from '../src/login.js'
import {prompter} from '../src/prompter.js'
import {restoreCredentialManagerStub, stubCredentialManager} from './helpers/credential-manager-stub.js'

class Command extends CommandBase {
  async run() {}
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

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
      api
        .post('/oauth/authorizations')
        .reply(401, {id: 'device_trust_required', message: 'original error message'})

      await cmd.heroku.login({method: 'interactive'})
        .catch(error => {
          expect(error.message).to.contain('The interactive flag requires Two-Factor Authentication')
          expect(error.message).to.contain('Error ID: device_trust_required')
        })
    })

  test
    .it('sends any other error message body through', async ctx => {
      const cmd = new Command([], ctx.config)
      api
        .post('/oauth/authorizations')
        .reply(401, {id: 'unauthorized', message: 'original error message'})

      await cmd.heroku.login({method: 'interactive'})
        .catch(error => {
          expect(error.message).to.contain('original error message')
          expect(error.message).to.contain('Error ID: unauthorized')
        })
    })

  test
    .it('defaults to 30 days login', async ctx => {
      const cmd = new Command([], ctx.config)
      api
        .post(
          '/oauth/authorizations',
          {description: /^Heroku CLI login from .*/, expires_in: 60 * 60 * 24 * 30, scope: ['global']},
        )
        .reply(401, {id: 'unauthorized', message: 'not authorized'})

      await cmd.heroku.login({method: 'interactive'})
        .catch(error => {
          expect(error.message).to.contain('Error ID: unauthorized')
        })
    })

  test
    .it('allows shorter logins', async ctx => {
      const cmd = new Command([], ctx.config)
      api
        .post(
          '/oauth/authorizations',
          {description: /^Heroku CLI login from .*/, expires_in: 12_345, scope: ['global']},
        )
        .reply(401, {id: 'unauthorized', message: 'not authorized'})

      await cmd.heroku.login({expiresIn: 12_345, method: 'interactive'})
        .catch(error => {
          expect(error.message).to.contain('Error ID: unauthorized')
        })
    })

  test
    .it('does not allow logins longer than 30 days', async ctx => {
      const cmd = new Command([], ctx.config)

      await cmd.heroku.login({expiresIn: 60 * 60 * 24 * 31, method: 'interactive'})
        .catch(error => {
          expect(error.message).to.contain('Cannot set an expiration longer than thirty days')
        })
    })
})

describe('login with browser', () => {
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
      api.get('/oauth/authorizations/~').reply(200, {})

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
