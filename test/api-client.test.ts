import {stderr} from 'stdout-stderr'
import {Config, ux} from '@oclif/core'
import base, {expect} from 'fancy-test'
import nock from 'nock'
import {resolve} from 'path'
import * as sinon from 'sinon'

import {Command as CommandBase} from '../src/command'
import {RequestId, requestIdHeader} from '../src/request-id'

class Command extends CommandBase {
  async run() {}
}

const netrc = require('netrc-parser').default
netrc.loadSync = function (this: typeof netrc) {
  netrc.machines = {
    'api.heroku.com': {password: 'mypass'},
  }
}

const env = process.env
let api: nock.Scope
beforeEach(() => {
  process.env = {}
  api = nock('https://api.heroku.com')
})
afterEach(() => {
  process.env = env
  api.done()
})

const test = base
  .add('config', new Config({root: resolve(__dirname, '../package.json')}))

describe('api_client', () => {
  test
    .it('makes an HTTP request', async ctx => {
      api = nock('https://api.heroku.com', {
        reqheaders: {authorization: 'Bearer mypass'},
      })
      api.get('/apps').reply(200, [{name: 'myapp'}])

      const cmd = new Command([], ctx.config)
      const {body} = await cmd.heroku.get('/apps')
      expect(body).to.deep.equal([{name: 'myapp'}])
      // expect(netrc.loadSync).toBeCalled()
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
    test
      .it('makes an HTTP request with HEROKU_HEADERS', async ctx => {
        process.env.HEROKU_HEADERS = '{"x-foo": "bar"}'
        api = nock('https://api.heroku.com', {
          reqheaders: {'x-foo': 'bar'},
        })
        api.get('/apps').reply(200, [{name: 'myapp'}])

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
      .it('doesn‘t fail or show delinquency warnings if Particleboard request fails', async ctx => {
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
      .it('doesn‘t show delinquency warnings if account isn‘t delinquent', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/account').reply(200, [{id: 'myid'}])
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/account').reply(200, {
          scheduled_suspension_time: null,
          scheduled_deletion_time: null,
        })

        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/account')

        expect(stderr.output).to.eq('')
        stderr.stop()
        particleboard.done()
      })

    test
      .it('shows a delinquency warning with suspension and deletion dates if account is delinquent', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/account').reply(200, [{id: 'myid'}])
        const suspensionTime = new Date('2024-06-01T12:00:00.000Z')
        const deletionTime = new Date('2024-06-15T23:59:59.999Z')
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/account').reply(200, {
          scheduled_suspension_time: suspensionTime.toISOString(),
          scheduled_deletion_time: deletionTime.toISOString(),
        })

        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/account')

        const stderrOutput = stderr.output.replace(/ *[»›] */g, '').replace(/ *\n */g, ' ')
        expect(stderrOutput).to.include(`This account is delinquent with payment and we‘ll suspend it on ${suspensionTime}`)
        expect(stderrOutput).to.include(`This account is delinquent with payment and we‘ll delete it on ${deletionTime}`)
        stderr.stop()
        particleboard.done()
      })

    test
      .it('it doesn‘t send a Particleboard request or show duplicated delinquency warnings with multiple matching requests when delinquent', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/account').reply(200, [{id: 'myid'}])
        api.get('/account').reply(200, [{id: 'myid'}])
        const suspensionTime = new Date('2024-06-01T12:00:00.000Z')
        const deletionTime = new Date('2024-06-15T23:59:59.999Z')
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard
          .get('/account').reply(200, {
            scheduled_suspension_time: suspensionTime.toISOString(),
            scheduled_deletion_time: deletionTime.toISOString(),
          })

        stderr.print = true
        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/account')

        const stderrOutput = stderr.output.replace(/ *[»›] */g, '').replace(/ *\n */g, ' ')
        expect(stderrOutput).to.include(`This account is delinquent with payment and we‘ll suspend it on ${suspensionTime}`)
        expect(stderrOutput).to.include(`This account is delinquent with payment and we‘ll delete it on ${deletionTime}`)
        stderr.stop()

        stderr.start()
        await cmd.heroku.get('/account')
        expect(stderr.output).to.eq('')
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
      .it('doesn‘t fail or show delinquency warnings if Particleboard request fails', async ctx => {
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
      .it('doesn‘t show delinquency warnings if team isn‘t delinquent', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/teams/my_team/members').reply(200, [{id: 'member_id'}])
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/teams/my_team').reply(200, {
          scheduled_suspension_time: null,
          scheduled_deletion_time: null,
        })

        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/teams/my_team/members')

        expect(stderr.output).to.eq('')
        stderr.stop()
        particleboard.done()
      })

    test
      .it('shows a delinquency warning with suspension and deletion dates if team is delinquent', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/teams/my_team/members').reply(200, [{id: 'member_id'}])
        const suspensionTime = new Date('2024-06-01T12:00:00.000Z')
        const deletionTime = new Date('2024-06-15T23:59:59.999Z')
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard.get('/teams/my_team').reply(200, {
          scheduled_suspension_time: suspensionTime.toISOString(),
          scheduled_deletion_time: deletionTime.toISOString(),
        })

        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/teams/my_team/members')

        const stderrOutput = stderr.output.replace(/ *[»›] */g, '').replace(/ *\n */g, ' ')
        expect(stderrOutput).to.include(`This team is delinquent with payment and we‘ll suspend it on ${suspensionTime}`)
        expect(stderrOutput).to.include(`This team is delinquent with payment and we‘ll delete it on ${deletionTime}`)
        stderr.stop()
        particleboard.done()
      })

    test
      .it('it doesn‘t send a Particleboard request or show duplicated delinquency warnings with multiple matching requests when delinquent', async ctx => {
        api = nock('https://api.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        api.get('/teams/my_team/members').reply(200, [{id: 'member_id'}])
        api.get('/teams/my_team/members').reply(200, [{id: 'member_id'}])
        const suspensionTime = new Date('2024-06-01T12:00:00.000Z')
        const deletionTime = new Date('2024-06-15T23:59:59.999Z')
        const particleboard = nock('https://particleboard.heroku.com', {
          reqheaders: {authorization: 'Bearer mypass'},
        })
        particleboard
          .get('/teams/my_team').reply(200, {
            scheduled_suspension_time: suspensionTime.toISOString(),
            scheduled_deletion_time: deletionTime.toISOString(),
          })

        stderr.print = true
        stderr.start()
        const cmd = new Command([], ctx.config)
        await cmd.heroku.get('/teams/my_team/members')

        const stderrOutput = stderr.output.replace(/ *[»›] */g, '').replace(/ *\n */g, ' ')
        expect(stderrOutput).to.include(`This team is delinquent with payment and we‘ll suspend it on ${suspensionTime}`)
        expect(stderrOutput).to.include(`This team is delinquent with payment and we‘ll delete it on ${deletionTime}`)
        stderr.stop()

        stderr.start()
        await cmd.heroku.get('/teams/my_team/members')

        expect(stderr.output).to.eq('')
        expect(stderr.output).to.eq('')
        stderr.stop()
        particleboard.done()
      })
  })

  test
    .it('2fa no preauth', async ctx => {
      api = nock('https://api.heroku.com')
      api.get('/apps').reply(403, {id: 'two_factor'})
      const _api = api as any
      _api.get('/apps').matchHeader('heroku-two-factor-code', '123456').reply(200, [{name: 'myapp'}])

      const cmd = new Command([], ctx.config)
      // todo: this should be stubbed, but other tests rely on it and break if it is done correctly
      Object.defineProperty(ux, 'prompt', {
        get: () => () => Promise.resolve('123456'),
      })
      const {body} = await cmd.heroku.get('/apps')
      expect(body).to.deep.equal([{name: 'myapp'}])
    })

  test
    .it('2fa preauth', async ctx => {
      api = nock('https://api.heroku.com')
      api.get('/apps/myapp').reply(403, {id: 'two_factor', app: {name: 'myapp'}})
      const _api = api as any
      _api.put('/apps/myapp/pre-authorizations').matchHeader('heroku-two-factor-code', '123456').reply(200, {})
      api.get('/apps/myapp').reply(200, {name: 'myapp'})
      api.get('/apps/anotherapp').reply(200, {name: 'anotherapp'})
      api.get('/apps/myapp/config').reply(200, {foo: 'bar'})
      api.get('/apps/myapp/dynos').reply(200, {web: 1})

      const cmd = new Command([], ctx.config)
      Object.defineProperty(ux, 'prompt', {
        get: () => () => Promise.resolve('123456'),
      })
      const info = cmd.heroku.get('/apps/myapp')
      const anotherapp = cmd.heroku.get('/apps/anotherapp')
      const _config = cmd.heroku.get('/apps/myapp/config')
      const dynos = cmd.heroku.get('/apps/myapp/dynos')
      expect((await info).body).to.deep.equal({name: 'myapp'})
      expect((await anotherapp).body).to.deep.equal({name: 'anotherapp'})
      expect((await _config).body).to.deep.equal({foo: 'bar'})
      expect((await dynos).body).to.deep.equal({web: 1})
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
        api = nock('https://api.heroku.com').get('/apps').twice().reply(() => [200, JSON.stringify({name: 'myapp'}), {[requestIdHeader]: existingRequestIds}])

        generateStub.returns('random-uuid')
        await cmd.heroku.get('/apps')

        generateStub.returns('second-random-uuid')
        const {request: secondRequest} = await cmd.heroku.get('/apps')

        expect(secondRequest.getHeader(requestIdHeader)).to.deep.equal('second-random-uuid,first-existing-request-id,second-existing-request-id,random-uuid')
      })
  })
})
