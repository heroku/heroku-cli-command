import {expect} from 'chai'

import {vars} from '../src/vars.js'

describe('vars', () => {
  const {env} = process

  beforeEach(() => {
    process.env = {}
  })

  afterEach(() => {
    process.env = env
  })

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

  it('rejects a look-alike loopback host that only contains "localhost"', () => {
    // Regression: a substring match accepted `localhost.attacker.example`, which
    // resolves to https://api.localhost.attacker.example — an attacker-controlled
    // host that would then be handed the CLI auth token. It must be rejected and
    // fall back to the default so no token is sent off-host.
    process.env.HEROKU_HOST = 'localhost.attacker.example'
    expect(vars.host).to.equal('heroku.com')
    expect(vars.apiHost).to.equal('api.heroku.com')
    expect(vars.apiUrl).to.equal('https://api.heroku.com')
  })

  it('rejects a host that embeds a heroku domain in userinfo', () => {
    // `api.heroku.com@evil.com` parses to the host `evil.com`; a scheme-stripped
    // substring test would have let it through.
    process.env.HEROKU_HOST = 'https://api.heroku.com@evil.com'
    expect(vars.host).to.equal('heroku.com')
    expect(vars.apiUrl).to.equal('https://api.heroku.com')
  })

  it('accepts genuine loopback hosts', () => {
    process.env.HEROKU_HOST = 'http://localhost:5000'
    expect(vars.host).to.equal('http://localhost:5000')
    expect(vars.apiUrl).to.equal('http://localhost:5000')
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
