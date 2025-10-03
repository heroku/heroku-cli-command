import {Config} from '@oclif/core'
import debug from 'debug'
import {expect, fancy} from 'fancy-test'
import nock from 'nock'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import * as sinon from 'sinon'
import {stderr} from 'stdout-stderr'

import {Command as CommandBase} from '../src/command.js'
import {RequestId, requestIdHeader} from '../src/request-id.js'
import {restoreNetrcStub, stubNetrc} from './helpers/netrc-stub.js'

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
    process.env = {}
    debug.disable()
    api = nock('https://api.heroku.com')
    stubNetrc()
  })

  afterEach(function () {
    process.env = env
    api.done()
    restoreNetrcStub()
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

        const stderrOutput = stderr.output.replace(/ *[»›] */g, '').replace(/ *\n */g, ' ')
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

        const stderrOutput = stderr.output.replace(/ *[»›] */g, '').replace(/ *\n */g, ' ')
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

        const stderrOutput = stderr.output.replace(/ *[»›] */g, '').replace(/ *\n */g, ' ')
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

        const stderrOutput = stderr.output.replace(/ *[»›] */g, '').replace(/ *\n */g, ' ')
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

        const stderrOutput = stderr.output.replace(/ *[»›] */g, '').replace(/ *\n */g, ' ')
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

        const stderrOutput = stderr.output.replace(/ *[»›] */g, '').replace(/ *\n */g, ' ')
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
