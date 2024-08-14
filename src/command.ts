import {Command as Base} from '@oclif/core'
import {deprecate} from 'util'

const pjson = require('../package.json')

import {APIClient, IOptions} from './api-client'
import deps from './deps'

const deprecatedCLI = deprecate(() => {
  return require('cli-ux').cli
}, 'this.out and this.cli is deprecated. Please import "CliUx" from the @oclif/core module directly instead.')

export abstract class Command extends Base {
  base = `${pjson.name}@${pjson.version}`
  _heroku!: APIClient
  _legacyHerokuClient: any

  get heroku(): APIClient {
    if (this._heroku) return this._heroku
    const options: IOptions = {
      debug: process.env.HEROKU_DEBUG === '1' || process.env.HEROKU_DEBUG?.toUpperCase() === 'TRUE',
      debugHeaders: process.env.HEROKU_DEBUG_HEADERS === '1' || process.env.HEROKU_DEBUG_HEADERS?.toUpperCase() === 'TRUE',
    }
    this._heroku = new deps.APIClient(this.config, options)
    return this._heroku
  }

  get legacyHerokuClient(): any {
    if (this._legacyHerokuClient) return this._legacyHerokuClient
    const HerokuClient = require('heroku-client')
    const options = {
      debug: this.config.debug,
      host: `${this.heroku.defaults.protocol || 'https:'}//${this.heroku.defaults.host ||
        'api.heroku.com'}`,
      token: this.heroku.auth,
      userAgent: (this.heroku.defaults as any).headers['user-agent'],
    }

    this._legacyHerokuClient = new HerokuClient(options)
    return this._legacyHerokuClient
  }

  get cli(): any {
    return deprecatedCLI()
  }

  get out(): any {
    return deprecatedCLI()
  }
}
