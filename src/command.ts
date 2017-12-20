import { Command as Base } from 'cli-engine-command'
import { APIClient } from './api_client'
import deps from './deps'

export abstract class Command extends Base {
  app: string | undefined
  _heroku: APIClient
  _legacyHerokuClient: any

  async init() {
    await super.init()
    if (this.flags.app) this.app = this.flags.app
  }

  get heroku(): APIClient {
    if (this._heroku) return this._heroku
    this._heroku = new deps.APIClient(this)
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
}
