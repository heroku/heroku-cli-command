import {HTTP} from '@heroku/http-call'
import {Errors, ux} from '@oclif/core'

import {Command} from '../src/index.js'

class StatusCommand extends Command {
  async run() {
    ux.stdout('Checking Heroku status...')

    const {body: status} = await HTTP.get('https://status.heroku.com/api/v4/current-status')

    if (Array.isArray(status) && status.length > 0) {
      this.log('\nCurrent Heroku Incidents:')
      for (const incident of status) {
        this.log(`\n${incident.name}`)
        this.log(`Status: ${incident.status}`)
        this.log(`Created: ${new Date(incident.created_at).toLocaleString()}`)
        if (incident.updated_at) {
          this.log(`Updated: ${new Date(incident.updated_at).toLocaleString()}`)
        }
      }
    } else {
      this.log('\nNo current incidents reported.')
    }
  }
}

(StatusCommand.run([]) as any)
  .catch(Errors.handle)
