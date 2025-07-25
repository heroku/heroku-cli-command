import {Config} from '@oclif/core'
import {expect, fancy} from 'fancy-test'
import inquirer from 'inquirer'
import nock from 'nock'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import * as sinon from 'sinon'

import {Command as CommandBase} from '../src/command.js'
import {restoreNetrcStub, stubNetrc} from './helpers/netrc-stub.js'

class Command extends CommandBase {
  async run() {}
}

let api: nock.Scope
beforeEach(() => {
  api = nock('https://api.heroku.com')
  api.delete('/oauth/sessions/~').reply(200, {})
  api.get('/oauth/authorizations').reply(200, [])
  api.get('/oauth/authorizations/~').reply(200, {})

  stubNetrc()

  // Mock inquirer prompts
  sinon.stub(inquirer, 'prompt').callsFake(async (questions: any) => {
    if (Array.isArray(questions)) {
      const answers: any = {}

      for (const q of questions) {
        if (q.name === 'email') answers.email = 'test@example.com'
        if (q.name === 'password') answers.password = 'test-password'
        if (q.name === 'secondFactor') answers.secondFactor = '123456'
        if (q.name === 'action') answers.action = 'y'
        if (q.name === 'orgName') answers.orgName = 'test-org'
      }

      return answers
    }

    return {}
  })
})

afterEach(() => {
  sinon.restore()
  restoreNetrcStub()
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const test = fancy
  .add('config', () => {
    const config = new Config({root: resolve(__dirname, '../package.json')})
    return config
  })

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
          {description: /^Heroku CLI login from .*/, expires_in: 60 * 60 * 24 * 30, scope: ['global']})
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
          {description: /^Heroku CLI login from .*/, expires_in: 12345, scope: ['global']})
        .reply(401, {id: 'unauthorized', message: 'not authorized'})

      await cmd.heroku.login({expiresIn: 12_345, method: 'interactive'})
        .catch(error => {
          expect(error.message).to.contain('Error ID: unauthorized')
        })
    })

  test
    .it('does not allow logins longer than 30 days', async ctx => {
      const cmd = new Command([], ctx.config)

      await cmd.heroku.login({expiresIn: 60 * 60 * 24 * 31, method: 'interactive'})
        .catch(error => {
          expect(error.message).to.contain('Cannot set an expiration longer than thirty days')
        })
    })
})
