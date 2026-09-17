import {ux} from '@oclif/core/ux'
import {expect} from 'chai'
import * as sinon from 'sinon'

import {Vars} from '../src/vars.js'

describe('vars', () => {
  const envKeys = ['HEROKU_CLOUD', 'HEROKU_GIT_HOST', 'HEROKU_HOST', 'HEROKU_PARTICLEBOARD_URL'] as const
  let env: Partial<Record<(typeof envKeys)[number], string>>
  let vars: Vars

  beforeEach(() => {
    env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
    for (const key of envKeys) delete process.env[key]
    vars = new Vars()
  })

  afterEach(() => {
    for (const key of envKeys) {
      const value = env[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
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

  for (const invalidHost of [
    'localhost.evil.example',
    'evil127.0.0.1.example',
    'https://localhost.evil.example',
    'https://evil127.0.0.1.example',
  ]) {
    it(`rejects HEROKU_HOST substring near miss ${invalidHost}`, () => {
      process.env.HEROKU_HOST = invalidHost
      expect(vars.host).to.equal('heroku.com')
    })
  }

  for (const [host, apiHost, apiUrl] of [
    ['http://127.0.0.1:5000', '127.0.0.1:5000', 'http://127.0.0.1:5000'],
    ['HTTP://127.255.2.3:5001', '127.255.2.3:5001', 'HTTP://127.255.2.3:5001'],
    ['http://localhost:5002', 'localhost:5002', 'http://localhost:5002'],
    ['http://[::1]:5003', '[::1]:5003', 'http://[::1]:5003'],
    ['127.42.0.9:5004', '127.42.0.9:5004', 'http://127.42.0.9:5004'],
    ['[::1]:5005', '[::1]:5005', 'http://[::1]:5005'],
    ['localhost:5006', 'localhost:5006', 'http://localhost:5006'],
  ]) {
    it(`accepts loopback HEROKU_HOST ${host}`, () => {
      process.env.HEROKU_HOST = host
      expect(vars.apiHost).to.equal(apiHost)
      expect(vars.apiUrl).to.equal(apiUrl)
    })
  }

  for (const invalidHost of [
    'http://heroku.com',
    'http://api.heroku.com:5000',
    'http://128.0.0.1',
    'http://127.256.0.1',
    'ftp://localhost',
    'https://heroku.com/path',
    'https://heroku.com?',
    'https://heroku.com#',
    'http://localhost?',
    'http://localhost#',
  ]) {
    it(`rejects unsafe HEROKU_HOST ${invalidHost}`, () => {
      process.env.HEROKU_HOST = invalidHost
      expect(vars.host).to.equal('heroku.com')
    })
  }

  it('warns once while deriving config for the same invalid HEROKU_HOST', () => {
    const warnStub = sinon.stub(ux, 'warn')
    try {
      process.env.HEROKU_HOST = 'localhost.evil.example'

      expect(vars.host).to.equal('heroku.com')
      expect(vars.apiHost).to.equal('api.heroku.com')
      expect(vars.apiUrl).to.equal('https://api.heroku.com')
      expect(vars.httpGitHost).to.equal('git.heroku.com')

      expect(warnStub.calledOnceWithExactly("Invalid HEROKU_HOST 'localhost.evil.example' - using default")).to.be.true
    } finally {
      warnStub.restore()
    }
  })

  it('redacts URL userinfo from invalid HEROKU_HOST diagnostics', () => {
    const warnStub = sinon.stub(ux, 'warn')
    try {
      process.env.HEROKU_HOST = 'https://private-user:private-password@example.com'

      expect(vars.host).to.equal('heroku.com')

      expect(warnStub.calledOnce).to.be.true
      expect(warnStub.firstCall.args[0]).to.contain('[REDACTED]@example.com')
      expect(warnStub.firstCall.args[0]).to.not.contain('private-user')
      expect(warnStub.firstCall.args[0]).to.not.contain('private-password')
    } finally {
      warnStub.restore()
    }
  })

  it('dedupes warnings by invalid raw value while continuing to re-resolve environment changes', () => {
    const warnStub = sinon.stub(ux, 'warn')
    try {
      process.env.HEROKU_HOST = 'first.invalid'
      expect(vars.apiUrl).to.equal('https://api.heroku.com')
      process.env.HEROKU_HOST = 'staging.heroku.com'
      expect(vars.apiUrl).to.equal('https://api.staging.heroku.com')
      process.env.HEROKU_HOST = 'first.invalid'
      expect(vars.apiUrl).to.equal('https://api.heroku.com')
      process.env.HEROKU_HOST = 'second.invalid'
      expect(vars.apiUrl).to.equal('https://api.heroku.com')

      expect(warnStub.args.map(([message]) => message)).to.deep.equal([
        "Invalid HEROKU_HOST 'first.invalid' - using default",
        "Invalid HEROKU_HOST 'second.invalid' - using default",
      ])
    } finally {
      warnStub.restore()
    }
  })

  it('re-resolves host config after process.env changes', () => {
    process.env.HEROKU_HOST = 'staging.heroku.com'
    expect(vars.apiUrl).to.equal('https://api.staging.heroku.com')

    process.env.HEROKU_HOST = 'http://localhost:5000'
    expect(vars.apiUrl).to.equal('http://localhost:5000')

    delete process.env.HEROKU_HOST
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
