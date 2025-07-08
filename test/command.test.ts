import {Config} from '@oclif/core'
import {expect, fancy} from 'fancy-test'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

import {Command} from '../src/command.js'
import * as flags from '../src/flags/index.js'

const test = fancy
  .add('config', () => {
    const config = new Config({root: resolve(__dirname, '../package.json')})
    return config
  })

class MyCommand extends Command {
  async run() {}
}

describe('command', () => {
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
})
