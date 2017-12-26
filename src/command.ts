import { Command as Base } from '@cli-engine/command'
import { deprecate } from 'util'

import { APIClient } from './api_client'
import deps from './deps'

const deprecatedCLI = deprecate(() => {
  return require('cli-ux').cli
}, 'this.out and this.cli is deprecated. Please import the "cli-ux" module directly instead.')

export abstract class Command extends Base {
  _heroku: APIClient
  _legacyHerokuClient: any

  get heroku(): APIClient {
    if (this._heroku) return this._heroku
    this._heroku = new deps.APIClient(this.config)
    return this._heroku
  }

  get legacyHerokuClient(): any {
    if (this._legacyHerokuClient) return this._legacyHerokuClient
    const HerokuClient = require('heroku-client')
    let options = {
      debug: this.config.debug,
      host: `${this.heroku.defaultOptions.protocol || 'https:'}//${this.heroku.defaultOptions.host ||
        'api.heroku.com'}`,
      token: this.heroku.auth,
      userAgent: (this.heroku.defaultOptions as any).headers['user-agent'],
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
  get app(): any {
    return deprecate(() => {
      return this.flags.app
    }, 'this.app is deprecated but you can implement it yourself as `get app() { return this.flags.app }`')()
  }
}
