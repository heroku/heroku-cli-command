import * as Config from '@oclif/config'
import cli from 'cli-ux'
import base, {expect} from 'fancy-test'
import nock from 'nock'

import {Command as CommandBase} from '../src/command'

class Command extends CommandBase {
  async run() {}
}

// jest.mock('netrc-parser', () => {
//   return {
//     default: {
//       loadSync: jest.fn(),
//       machines: {'api.heroku.com': {password: 'mypass'}},
//     },
//   }
// })

const netrc = require('netrc-parser').default
netrc.loadSync = function (this: typeof netrc) {
  netrc.machines = {
    'api.heroku.com': {password: 'mypass'}
  }
}

let env = process.env
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
.add('config', () => Config.load())

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

  test
  .it('2fa no preauth', async ctx => {
    api = nock('https://api.heroku.com')
    api.get('/apps').reply(403, {id: 'two_factor'})
    let _api = api as any
    _api.get('/apps').matchHeader('heroku-two-factor-code', '123456').reply(200, [{name: 'myapp'}])

    const cmd = new Command([], ctx.config)
    Object.defineProperty(cli, 'prompt', {
      get: () => () => Promise.resolve('123456')
    })
    const {body} = await cmd.heroku.get('/apps')
    expect(body).to.deep.equal([{name: 'myapp'}])
  })

  test
  .it('2fa preauth', async ctx => {
    api = nock('https://api.heroku.com')
    api.get('/apps/myapp').reply(403, {id: 'two_factor', app: {name: 'myapp'}})
    let _api = api as any
    _api.put('/apps/myapp/pre-authorizations').matchHeader('heroku-two-factor-code', '123456').reply(200, {})
    api.get('/apps/myapp').reply(200, {name: 'myapp'})
    api.get('/apps/anotherapp').reply(200, {name: 'anotherapp'})
    api.get('/apps/myapp/config').reply(200, {foo: 'bar'})
    api.get('/apps/myapp/dynos').reply(200, {web: 1})

    const cmd = new Command([], ctx.config)
    Object.defineProperty(cli, 'prompt', {
      get: () => () => Promise.resolve('123456')
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
})
