import {handle} from '@oclif/core/errors'

import {Command} from '../src/index.js'

class LogoutCommand extends Command {
  async run() {
    this.log('logging out')
    await this.heroku.logout()
  }
}

try {
  await LogoutCommand.run([])
} catch (error: unknown) {
  handle(error as Error)
}
