// @flow

import {Vars} from './vars'

jest.mock('netrc-parser', () => {
  return class {
    machines = {'api.heroku.com': {password: 'mypass'}}
  }
})

test('sets vars by default', () => {
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

test('respects HEROKU_HOST', () => {
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

test('respects HEROKU_HOST as url', () => {
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
