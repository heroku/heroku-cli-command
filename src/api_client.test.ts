import cli from 'cli-ux'
import * as nock from 'nock'
import { Command as CommandBase } from './command'

class Command extends CommandBase {
  async run() {}
}

jest.mock('netrc-parser', () => {
  return class {
    machines = { 'api.heroku.com': { password: 'mypass' } }
  }
})

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

test('makes an HTTP request', async () => {
  api = nock('https://api.heroku.com', {
    reqheaders: { authorization: 'Bearer mypass' },
  })
  api.get('/apps').reply(200, [{ name: 'myapp' }])

  const { cmd } = await Command.mock()
  const { body } = await cmd.heroku.get('/apps')
  expect(body).toEqual([{ name: 'myapp' }])
})

describe('with HEROKU_HEADERS', () => {
  test('makes an HTTP request with HEROKU_HEADERS', async () => {
    process.env.HEROKU_HEADERS = `{"x-foo": "bar"}`
    api = nock('https://api.heroku.com', {
      reqheaders: { 'x-foo': 'bar' },
    })
    api.get('/apps').reply(200, [{ name: 'myapp' }])

    const { cmd } = await Command.mock()
    const { body } = await cmd.heroku.get('/apps')
    expect(body).toEqual([{ name: 'myapp' }])
  })
})

test('2fa no preauth', async () => {
  api = nock('https://api.heroku.com')
  api.get('/apps').reply(403, { id: 'two_factor' })
  ;(api.get('/apps') as any).matchHeader('heroku-two-factor-code', '123456').reply(200, [{ name: 'myapp' }])

  const { cmd } = await Command.mock()
  cli.prompt = jest.fn().mockReturnValueOnce(Promise.resolve('123456'))
  const { body } = await cmd.heroku.get('/apps')
  expect(body).toEqual([{ name: 'myapp' }])
})

test('2fa preauth', async () => {
  api = nock('https://api.heroku.com')
  api.get('/apps/myapp').reply(403, { id: 'two_factor', app: { name: 'myapp' } })
  ;(api.put('/apps/myapp/pre-authorizations') as any).matchHeader('heroku-two-factor-code', '123456').reply(200, {})
  api.get('/apps/myapp').reply(200, { name: 'myapp' })
  api.get('/apps/anotherapp').reply(200, { name: 'anotherapp' })
  api.get('/apps/myapp/config').reply(200, { foo: 'bar' })
  api.get('/apps/myapp/dynos').reply(200, { web: 1 })

  const { cmd } = await Command.mock()
  cli.prompt = jest.fn().mockReturnValueOnce(Promise.resolve('123456'))
  const info = cmd.heroku.get('/apps/myapp')
  const anotherapp = cmd.heroku.get('/apps/anotherapp')
  const config = cmd.heroku.get('/apps/myapp/config')
  const dynos = cmd.heroku.get('/apps/myapp/dynos')
  expect((await info).body).toEqual({ name: 'myapp' })
  expect((await anotherapp).body).toEqual({ name: 'anotherapp' })
  expect((await config).body).toEqual({ foo: 'bar' })
  expect((await dynos).body).toEqual({ web: 1 })
})
