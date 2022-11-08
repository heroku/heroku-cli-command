import {expect} from 'chai'

import {vars} from '../src/vars'

const env = process.env
beforeEach(() => {
  process.env = {}
})
afterEach(() => {
  process.env = env
})

// jest.mock('netrc-parser', () => {
//   return class {
//     machines = {'api.heroku.com': {password: 'mypass'}}
//   }
// })

describe('vars', () => {
  it('sets vars by default', () => {
    expect(vars.host).to.equal('heroku.com')
    expect(vars.apiHost).to.equal('api.heroku.com')
    expect(vars.gitHost).to.equal('heroku.com')
    expect(vars.apiUrl).to.equal('https://api.heroku.com')
    expect(vars.gitHost).to.equal('heroku.com')
    expect(vars.httpGitHost).to.equal('git.heroku.com')
    expect(vars.gitPrefixes).to.deep.equal(['git@heroku.com:', 'ssh://git@heroku.com/', 'https://git.heroku.com/'])
  })

  it('respects HEROKU_HOST', () => {
    process.env.HEROKU_HOST = 'customhost'
    expect(vars.apiHost).to.equal('api.customhost')
    expect(vars.apiUrl).to.equal('https://api.customhost')
    expect(vars.gitHost).to.equal('customhost')
    expect(vars.host).to.equal('customhost')
    expect(vars.httpGitHost).to.equal('git.customhost')
    expect(vars.gitPrefixes).to.deep.equal(['git@customhost:', 'ssh://git@customhost/', 'https://git.customhost/'])
  })

  it('respects HEROKU_HOST as url', () => {
    process.env.HEROKU_HOST = 'https://customhost'
    expect(vars.host).to.equal('https://customhost')
    expect(vars.apiHost).to.equal('customhost')
    expect(vars.apiUrl).to.equal('https://customhost')
    expect(vars.gitHost).to.equal('customhost')
    expect(vars.httpGitHost).to.equal('customhost')
    expect(vars.gitPrefixes).to.deep.equal(['git@customhost:', 'ssh://git@customhost/', 'https://customhost/'])
  })
})
