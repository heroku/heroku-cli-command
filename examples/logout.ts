import {handle} from '@oclif/core/errors'

import {Command} from '../src/index.js'

class LogoutCommand extends Command {
  async run() {
    this.log('logging out')
    await this.heroku.logout()
  }
}

(LogoutCommand.run([]) as any)
  .catch(handle)
