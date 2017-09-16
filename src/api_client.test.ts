import * as nock from 'nock'
import { Command } from './command'

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

  const cmd = new Command()
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

    const cmd = new Command()
    const { body } = await cmd.heroku.get('/apps')
    expect(body).toEqual([{ name: 'myapp' }])
  })
})
