import * as Config from '@anycli/config'
import {expect} from 'chai'

import {Command} from '../src/command'
import * as flags from '../src/flags'

const config = Config.load()

class MyCommand extends Command {
  async run() {
  }
}

describe('command', () => {
  it('sets app', () => {
    return class AppCommand extends Command {
      static flags = {
        app: flags.app(),
      }

      async run() {
        const {flags} = this.parse(AppCommand)
        expect(flags.app).to.equal('myapp')
      }
    }.run(['--app=myapp'])
  })

  it('has heroku clients', async () => {
    let cmd = new MyCommand([], config)
    expect(cmd.heroku).to.be.ok
    expect(cmd.legacyHerokuClient).to.be.ok
  })
})
