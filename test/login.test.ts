import {Config} from '@oclif/core'
import base, {expect} from 'fancy-test'
import nock from 'nock'
import {resolve} from 'path'
import * as sinon from 'sinon'
import Netrc from 'netrc-parser'

import {Command as CommandBase} from '../src/command'

class Command extends CommandBase {
  async run() {}
}

let api: nock.Scope
beforeEach(() => {
  api = nock('https://api.heroku.com')
  api.delete('/oauth/sessions/~').reply(200, {})
  api.get('/oauth/authorizations').reply(200, [])
  api.get('/oauth/authorizations/~').reply(200, {})

  // Mock netrc-parser
  sinon.stub(Netrc, 'load').resolves()
  sinon.stub(Netrc, 'save').resolves()
})

afterEach(() => {
  sinon.restore()
})

const test = base
  .add('config', new Config({root: resolve(__dirname, '../package.json')}))

describe('login with interactive', () => {
  test
    .it('throws a custom error message body for device_trust_required error', async ctx => {
      const cmd = new Command([], ctx.config)
      api
        .post('/oauth/authorizations')
        .reply(401, {id: 'device_trust_required', message: 'original error message'})

      await cmd.heroku.login({method: 'interactive'})
        .catch(error => {
          expect(error.message).to.contain('The interactive flag requires Two-Factor Authentication')
          expect(error.message).to.contain('Error ID: device_trust_required')
        })
    })

  test
    .it('sends any other error message body through', async ctx => {
      const cmd = new Command([], ctx.config)
      api
        .post('/oauth/authorizations')
        .reply(401, {id: 'unauthorized', message: 'original error message'})

      await cmd.heroku.login({method: 'interactive'})
        .catch(error => {
          expect(error.message).to.contain('original error message')
          expect(error.message).to.contain('Error ID: unauthorized')
        })
    })

  test
    .it('defaults to 30 days login', async ctx => {
      const cmd = new Command([], ctx.config)
      api
        .post('/oauth/authorizations',
          {scope: ['global'], description: /^Heroku CLI login from .*/, expires_in: 60 * 60 * 24 * 30})
        .reply(401, {id: 'unauthorized', message: 'not authorized'})

      await cmd.heroku.login({method: 'interactive'})
        .catch(error => {
          expect(error.message).to.contain('Error ID: unauthorized')
        })
    })

  test
    .it('allows shorter logins', async ctx => {
      const cmd = new Command([], ctx.config)
      api
        .post('/oauth/authorizations',
          {scope: ['global'], description: /^Heroku CLI login from .*/, expires_in: 12345})
        .reply(401, {id: 'unauthorized', message: 'not authorized'})

      await cmd.heroku.login({method: 'interactive', expiresIn: 12_345})
        .catch(error => {
          expect(error.message).to.contain('Error ID: unauthorized')
        })
    })

  test
    .it('does not allow logins longer than 30 days', async ctx => {
      const cmd = new Command([], ctx.config)

      await cmd.heroku.login({method: 'interactive', expiresIn: 60 * 60 * 24 * 31})
        .catch(error => {
          expect(error.message).to.contain('Cannot set an expiration longer than thirty days')
        })
    })
})
