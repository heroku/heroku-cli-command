import {Command} from '../src'

class LoginCommand extends Command {
  async run() {
    this.log('logging in')
    await this.heroku.login()
  }
}

(LoginCommand.run([]) as any)
  .catch(require('@oclif/core').Errors.handle)
