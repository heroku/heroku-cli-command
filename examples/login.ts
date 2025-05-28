import {Command, flags} from '../src/index.js'

class LoginCommand extends Command {
  static flags = {
    interactive: flags.boolean({char: 'i', description: 'login with username/password'}),
  }

  async run() {
    const {flags} = await this.parse(LoginCommand)
    this.log('logging in')
    const interactive = (flags.interactive) ? 'interactive' : undefined
    await this.heroku.login({method: interactive})
  }
}

(LoginCommand.run(process.argv.slice(2)) as any)
  .catch(require('@oclif/core').Errors.handle)
