import {Config} from '@oclif/core'
import base, {expect} from 'fancy-test'

import {Command} from '../src/command'
import * as flags from '../src/flags'

const test = base
.add('config', () => Config.load())

class MyCommand extends Command {
  async run() {}
}

describe('command', () => {
  it('sets app', () => {
    return class AppCommand extends Command {
      static flags = {
        app: flags.app(),
      }

      async run() {
        const {flags} = await this.parse(AppCommand)
        expect(flags.app).to.equal('myapp')
      }
    }.run(['--app=myapp'])
  })

  test
  .it('has heroku clients', async ctx => {
    const cmd = new MyCommand([], ctx.config as Config)
    expect(cmd.heroku).to.be.ok
    expect(cmd.legacyHerokuClient).to.be.ok
  })
})
