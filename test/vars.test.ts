import {expect} from 'chai'

import {vars} from '../src/vars.js'

const {env} = process
beforeEach(() => {
  process.env = {}
})
afterEach(() => {
  process.env = env
})

describe('vars', () => {
  it('sets vars by default', () => {
    expect(vars.host).to.equal('heroku.com')
    expect(vars.apiHost).to.equal('api.heroku.com')
    expect(vars.gitHost).to.equal('heroku.com')
    expect(vars.apiUrl).to.equal('https://api.heroku.com')
    expect(vars.gitHost).to.equal('heroku.com')
    expect(vars.httpGitHost).to.equal('git.heroku.com')
    expect(vars.gitPrefixes).to.deep.equal(['git@heroku.com:', 'ssh://git@heroku.com/', 'https://git.heroku.com/'])
    expect(vars.particleboardUrl).to.equal('https://particleboard.heroku.com')
  })

  it('respects HEROKU_HOST', () => {
    process.env.HEROKU_HOST = 'customhost'
    expect(vars.apiHost).to.equal('api.customhost')
    expect(vars.apiUrl).to.equal('https://api.customhost')
    expect(vars.gitHost).to.equal('customhost')
    expect(vars.host).to.equal('customhost')
    expect(vars.httpGitHost).to.equal('git.customhost')
    expect(vars.gitPrefixes).to.deep.equal(['git@customhost:', 'ssh://git@customhost/', 'https://git.customhost/'])
    expect(vars.particleboardUrl).to.equal('https://particleboard.heroku.com')
  })

  it('respects HEROKU_HOST as url', () => {
    process.env.HEROKU_HOST = 'https://customhost'
    expect(vars.host).to.equal('https://customhost')
    expect(vars.apiHost).to.equal('customhost')
    expect(vars.apiUrl).to.equal('https://customhost')
    expect(vars.gitHost).to.equal('customhost')
    expect(vars.httpGitHost).to.equal('customhost')
    expect(vars.gitPrefixes).to.deep.equal(['git@customhost:', 'ssh://git@customhost/', 'https://customhost/'])
    expect(vars.particleboardUrl).to.equal('https://particleboard.heroku.com')
  })

  it('respects HEROKU_PARTICLEBOARD_URL', () => {
    process.env.HEROKU_PARTICLEBOARD_URL = 'https://customhost'
    expect(vars.particleboardUrl).to.equal('https://customhost')
  })

  it('respects HEROKU_CLOUD', () => {
    process.env.HEROKU_CLOUD = 'staging'
    expect(vars.particleboardUrl).to.equal('https://particleboard-staging-cloud.herokuapp.com')
  })
})
