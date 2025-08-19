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
    expect(vars.particleboardUrl).to.equal('https://particleboard.heroku.com')
  })

  it('respects valid HEROKU_HOST values', () => {
    // Test with a valid heroku.com subdomain
    process.env.HEROKU_HOST = 'staging.heroku.com'
    expect(vars.apiHost).to.equal('api.staging.heroku.com')
    expect(vars.apiUrl).to.equal('https://api.staging.heroku.com')
    expect(vars.gitHost).to.equal('staging.heroku.com')
    expect(vars.host).to.equal('staging.heroku.com')
    expect(vars.httpGitHost).to.equal('git.staging.heroku.com')
    expect(vars.gitPrefixes).to.deep.equal(['git@staging.heroku.com:', 'ssh://git@staging.heroku.com/', 'https://git.staging.heroku.com/'])
    expect(vars.particleboardUrl).to.equal('https://particleboard.heroku.com')
  })

  it('rejects invalid HEROKU_HOST values for security', () => {
    // Test that invalid hosts are rejected and fallback to default
    process.env.HEROKU_HOST = 'bogus-server.com'
    expect(vars.host).to.equal('heroku.com') // Should fallback to default
    expect(vars.apiHost).to.equal('api.heroku.com')
    expect(vars.apiUrl).to.equal('https://api.heroku.com')
  })

  it('respects legitimate HEROKU_HOST as url', () => {
    // Test with a valid heroku.com subdomain URL
    process.env.HEROKU_HOST = 'https://staging.heroku.com'
    expect(vars.host).to.equal('https://staging.heroku.com')
    expect(vars.apiHost).to.equal('staging.heroku.com')
    expect(vars.apiUrl).to.equal('https://staging.heroku.com')
    expect(vars.gitHost).to.equal('staging.heroku.com')
    expect(vars.httpGitHost).to.equal('staging.heroku.com')
    expect(vars.gitPrefixes).to.deep.equal(['git@staging.heroku.com:', 'ssh://git@staging.heroku.com/', 'https://staging.heroku.com/'])
    expect(vars.particleboardUrl).to.equal('https://particleboard.heroku.com')
  })

  it('rejects invalid HEROKU_HOST URLs', () => {
    // Test that invalid URL hosts are rejected and fallback to default
    process.env.HEROKU_HOST = 'https://bogus-server.com'
    expect(vars.host).to.equal('heroku.com') // Should fallback to default for security
    expect(vars.apiHost).to.equal('api.heroku.com')
    expect(vars.apiUrl).to.equal('https://api.heroku.com')
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
