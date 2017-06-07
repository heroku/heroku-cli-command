// @flow

import nock from 'nock'
import Command from './command'

jest.mock('netrc-parser', () => {
  return class {
    machines = {'api.heroku.com': {password: 'mypass'}}
  }
})

let api
beforeEach(() => {
  api = nock('https://api.heroku.com')
})
afterEach(() => api.done())

test('makes an HTTP request', async () => {
  api.get('/apps')
  .matchHeader('authorization', 'Bearer mypass')
  .reply(200, [{name: 'myapp'}])

  const cmd = await Command.mock()
  const response = await cmd.heroku.get('/apps')
  expect(response).toEqual([{name: 'myapp'}])
})
