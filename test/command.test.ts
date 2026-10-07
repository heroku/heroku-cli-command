import {Config} from '@oclif/core/config'
import {expect, fancy} from 'fancy-test'
import nock from 'nock'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import * as sinon from 'sinon'

import {Command} from '../src/command.js'
import {setCredentialManagerProvider} from '../src/credential-manager.js'
import * as flags from '../src/flags/index.js'
import {restoreCredentialManagerStub, stubCredentialManager, stubCredentialManagerWithNoCredentials} from './helpers/credential-manager-stub.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const {env: processEnv} = process

const test = fancy
  .add('config', () => {
    const config = new Config({root: resolve(__dirname, '../package.json')})
    return config
  })

class MyCommand extends Command {
  async run() {}
}

/** Exposes protected isPromptModeActive for testing */
class TestableCommand extends Command {
  isPromptModeActivePublic(): boolean {
    return this.isPromptModeActive()
  }

  async run() {}
}

class CommandWithPromptFlagDisabled extends TestableCommand {
  static promptFlagActive = false
}

class CommandWithoutPromptInBaseFlags extends TestableCommand {
  static baseFlags = Command.baseFlagsWithoutPrompt()
}

describe('command', () => {
  describe('credential preload in init', () => {
    beforeEach(() => {
      process.env = {}
      stubCredentialManager('mypass')
    })

    afterEach(() => {
      process.env = processEnv
      restoreCredentialManagerStub()
    })

    test
      .it('populates this.heroku.auth after init so sync checks see the token', async (ctx: any) => {
        const cmd = new MyCommand([], ctx.config)
        cmd.config = ctx.config
        await cmd.init()
        expect(cmd.heroku.auth).to.equal('mypass')
      })

    test
      .it('uses HEROKU_API_KEY over credential store in init', async (ctx: any) => {
        process.env.HEROKU_API_KEY = 'env-token'
        const cmd = new MyCommand([], ctx.config)
        cmd.config = ctx.config
        await cmd.init()
        expect(cmd.heroku.auth).to.equal('env-token')
      })

    test
      .it('leaves this.heroku.auth undefined after init when no credentials exist', async (ctx: any) => {
        restoreCredentialManagerStub()
        stubCredentialManagerWithNoCredentials()
        const cmd = new MyCommand([], ctx.config)
        cmd.config = ctx.config
        await cmd.init()
        expect(cmd.heroku.auth).to.be.undefined
      })
  })

  describe('logout operation auth', () => {
    beforeEach(() => {
      process.env = {}
      nock.cleanAll()
    })

    afterEach(() => {
      process.env = processEnv
      sinon.restore()
      nock.cleanAll()
      restoreCredentialManagerStub()
    })

    test
      .it('keeps snapshot token B on logout get/delete requests when ambient auth rotates to token A', async (ctx: any) => {
        const removeCalls: unknown[][] = []
        const cmd = new MyCommand([], ctx.config)
        cmd.config = ctx.config
        setCredentialManagerProvider({
          async getAuth() {
            return {account: 'operation@example.com', token: 'token-b'}
          },
          async removeAuth(...args) {
            removeCalls.push(args)
            cmd.heroku.setAuthEntry({account: 'ambient@example.com', token: 'token-a'})
          },
          async saveAuth() {},
        })
        const api = nock('https://api.heroku.com', {reqheaders: {authorization: 'Bearer token-b'}})
          .delete('/oauth/sessions/~')
          .reply(401, {})
          .get('/oauth/authorizations')
          .reply(401, {})
        const commandLogin = sinon.spy(cmd.heroku, 'login')

        await cmd.heroku.logout()

        expect(api.isDone()).to.equal(true)
        expect(commandLogin.called).to.equal(false)
        expect(removeCalls).to.deep.equal([[
          'operation@example.com',
          ['api.heroku.com', 'git.heroku.com'],
          'heroku-cli',
          'token-b',
        ]])
        expect(cmd.heroku.auth).to.equal('token-a')
      })
  })

  it('sets app', () => class AppCommand extends Command {
    static flags = {
      app: flags.app(),
    }

    async run() {
      const {flags} = await this.parse(AppCommand)
      expect(flags.app).to.equal('myapp')
    }
  }.run(['--app=myapp']))

  test
    .it('has heroku clients', async (ctx: any) => {
      const cmd = new MyCommand([], ctx.config)
      cmd.config = ctx.config
      expect(cmd.heroku).to.be.ok
    })

  test
    .it('isPromptModeActive returns true when prompt is in baseFlags and promptFlagActive is true', async (ctx: any) => {
      const cmd = new TestableCommand([], ctx.config)
      cmd.config = ctx.config
      expect(cmd.isPromptModeActivePublic()).to.be.true
    })

  test
    .it('isPromptModeActive returns false when promptFlagActive is false', async (ctx: any) => {
      const cmd = new CommandWithPromptFlagDisabled([], ctx.config)
      cmd.config = ctx.config
      expect(cmd.isPromptModeActivePublic()).to.be.false
    })

  test
    .it('isPromptModeActive returns false when prompt is not in baseFlags', async (ctx: any) => {
      const cmd = new CommandWithoutPromptInBaseFlags([], ctx.config)
      cmd.config = ctx.config
      expect(cmd.isPromptModeActivePublic()).to.be.false
    })
})
