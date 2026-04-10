import * as Heroku from '@heroku-cli/schema'
import {HTTPError} from '@heroku/http-call'
import {handle} from '@oclif/core/errors'
import {ux} from '@oclif/core/ux'

import {Command} from '../src/index.js'

class StatusCommand extends Command {
  notloggedin() {
    this.error('not logged in', {exit: 100})
  }

  async run() {
    if (process.env.HEROKU_API_KEY) this.warn('HEROKU_API_KEY is set')
    if (!(await this.heroku.getAuth())) this.notloggedin()
    try {
      const {body: account} = await this.heroku.get<Heroku.Account>('/account', {retryAuth: false})
      ux.stdout(account.email)
    } catch (error: unknown) {
      if (error instanceof HTTPError && error.statusCode === 401) this.notloggedin()
      throw error
    }
  }
}

try {
  await StatusCommand.run([])
} catch (error: unknown) {
  handle(error as Error)
}
