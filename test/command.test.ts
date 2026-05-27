import {Config} from '@oclif/core/config'
import {expect, fancy} from 'fancy-test'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

import {Command} from '../src/command.js'
import * as flags from '../src/flags/index.js'
import {restoreCredentialManagerStub, stubCredentialManager, stubCredentialManagerWithNoCredentials} from './helpers/credential-manager-stub.js'

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
