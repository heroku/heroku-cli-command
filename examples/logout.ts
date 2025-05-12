/* eslint-disable unicorn/prefer-top-level-await */
import {Command} from '../src'

class LogoutCommand extends Command {
  async run() {
    this.log('logging out')
    await this.heroku.logout()
  }
}

(LogoutCommand.run([]) as any)
  .catch(require('@oclif/core').Errors.handle)
