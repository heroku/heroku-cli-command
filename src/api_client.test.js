// @flow

import nock from 'nock'
import Command from './command'
import {Vars} from './api_client'

jest.mock('netrc-parser', () => {
  return class {
    machines = {'api.heroku.com': {password: 'mypass'}}
  }
})

describe('vars', () => {
  it('sets vars by default', () => {
    const vars = new Vars({})
    expect(vars.host).toEqual('heroku.com')
    expect(vars.apiHost).toEqual('api.heroku.com')
    expect(vars.gitHost).toEqual('heroku.com')
    expect(vars.apiUrl).toEqual('https://api.heroku.com')
    expect(vars.gitHost).toEqual('heroku.com')
    expect(vars.httpGitHost).toEqual('git.heroku.com')
    expect(vars.gitPrefixes).toEqual([
      'git@heroku.com:',
      'ssh://git@heroku.com/',
      'https://git.heroku.com/'
    ])
  })

  it('respects HEROKU_HOST', () => {
    const vars = new Vars({HEROKU_HOST: 'customhost'})
    expect(vars.apiHost).toEqual('api.customhost')
    expect(vars.apiUrl).toEqual('https://api.customhost')
    expect(vars.gitHost).toEqual('customhost')
    expect(vars.host).toEqual('customhost')
    expect(vars.httpGitHost).toEqual('git.customhost')
    expect(vars.gitPrefixes).toEqual([
      'git@customhost:',
      'ssh://git@customhost/',
      'https://git.customhost/'
    ])
  })

  it('respects HEROKU_HOST as url', () => {
    const vars = new Vars({HEROKU_HOST: 'https://customhost'})
    expect(vars.host).toEqual('https://customhost')
    expect(vars.apiHost).toEqual('customhost')
    expect(vars.apiUrl).toEqual('https://customhost')
    expect(vars.gitHost).toEqual('customhost')
    expect(vars.httpGitHost).toEqual('customhost')
    expect(vars.gitPrefixes).toEqual([
      'git@customhost:',
      'ssh://git@customhost/',
      'https://customhost/'
    ])
  })
})

describe('api client', () => {
  let api
  beforeEach(() => {
    api = nock('https://api.heroku.com')
  })
  afterEach(() => api.done())

  test('makes an HTTP request', async () => {
    api.get('/apps')
    .matchHeader('authorization', ':mypass')
    .reply(200, [{name: 'myapp'}])

    const cmd = await Command.mock()
    const response = await cmd.heroku.get('/apps')
    expect(response).toEqual([{name: 'myapp'}])
  })
})
