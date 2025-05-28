import * as Heroku from '@heroku-cli/schema'
import {ux} from '@oclif/core'

import {Command} from '../src/index.js'

class StatusCommand extends Command {
  notloggedin() {
    this.error('not logged in', {exit: 100})
  }

  async run() {
    if (process.env.HEROKU_API_KEY) this.warn('HEROKU_API_KEY is set')
    if (!this.heroku.auth) this.notloggedin()
    try {
      const {body: account} = await this.heroku.get<Heroku.Account>('/account', {retryAuth: false})
      ux.stdout(account.email)
    } catch (error: any) {
      if (error.statusCode === 401) this.notloggedin()
      throw error
    }
  }
}

(StatusCommand.run([]) as any)
  .catch(require('@oclif/core').Errors.handle)

