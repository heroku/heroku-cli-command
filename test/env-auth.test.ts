import {expect} from 'chai'

import {resolveEnvToken} from '../src/env-auth.js'

describe('resolveEnvToken', () => {
  const {env} = process

  beforeEach(() => {
    process.env = {}
  })

  afterEach(() => {
    process.env = env
  })

  const collectWarnings = () => {
    const warnings: string[] = []
    const warn = (message: string): void => {
      warnings.push(message)
    }

    return {warn, warnings}
  }

  it('returns the HEROKU_API_KEY token with no warning', () => {
    process.env.HEROKU_API_KEY = 'key-token'
    const {warn, warnings} = collectWarnings()
    expect(resolveEnvToken(warn)).to.equal('key-token')
    expect(warnings).to.deep.equal([])
  })

  it('returns no token when nothing is set, and does not warn', () => {
    const {warn, warnings} = collectWarnings()
    expect(resolveEnvToken(warn)).to.be.undefined
    expect(warnings).to.deep.equal([])
  })

  it('warns and returns no token when HEROKU_API_TOKEN is set without HEROKU_API_KEY', () => {
    process.env.HEROKU_API_TOKEN = 'mistaken-token'
    const {warn, warnings} = collectWarnings()
    expect(resolveEnvToken(warn)).to.be.undefined
    expect(warnings).to.have.lengthOf(1)
    expect(warnings[0]).to.match(/HEROKU_API_TOKEN is set but you probably meant HEROKU_API_KEY/)
  })

  it('treats an empty HEROKU_API_KEY as unset', () => {
    process.env.HEROKU_API_KEY = ''
    const {warn, warnings} = collectWarnings()
    expect(resolveEnvToken(warn)).to.be.undefined
    expect(warnings).to.deep.equal([])
  })

  it('does not warn when both HEROKU_API_KEY and HEROKU_API_TOKEN are set', () => {
    process.env.HEROKU_API_KEY = 'key-token'
    process.env.HEROKU_API_TOKEN = 'also-set'
    const {warn, warnings} = collectWarnings()
    expect(resolveEnvToken(warn)).to.equal('key-token')
    expect(warnings).to.deep.equal([])
  })
})
