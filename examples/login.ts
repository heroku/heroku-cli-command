import {Command} from '../src'

class LoginCommand extends Command {
  async run() {
    this.log('logging in')
    await this.heroku.login()
  }
}

LoginCommand.run([])
.catch(require('@oclif/errors/handle'))
