import {Errors} from '@oclif/core'

import {Command} from '../src/index.js'

class LogoutCommand extends Command {
  async run() {
    this.log('logging out')
    await this.heroku.logout()
  }
}

(LogoutCommand.run([]) as any)
  .catch(Errors.handle)
