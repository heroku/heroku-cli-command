import {Command} from '../src'

class LoginCommand extends Command {
  async run() {
    this.log('logging out')
    await this.heroku.logout()
  }
}

LoginCommand.run([])
  .catch(require('@oclif/errors/handle'))
