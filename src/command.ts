import { Command as Base } from 'cli-engine-command'
import { APIClient } from './api_client'

export class Command extends Base {
  app: string | undefined
  _heroku: APIClient
  _legacyHerokuClient: any

  async init() {
    await super.init()
    this.app = (<any>this.flags).app
  }

  get heroku(): APIClient {
    if (this._heroku) return this._heroku
    this._heroku = new APIClient({ config: this.config })
    return this._heroku
  }
  get legacyHerokuClient(): any {
    if (this._legacyHerokuClient) return this._legacyHerokuClient
    const HerokuClient = require('heroku-client')
    let options = {
      userAgent: (<any>this.heroku.defaultOptions).headers['user-agent'],
      debug: this.config.debug,
      token: this.heroku.auth,
      host: `${this.heroku.defaultOptions.protocol || 'https:'}//${this.heroku.defaultOptions.host ||
        'api.heroku.com'}`,
    }

    this._legacyHerokuClient = new HerokuClient(options)
    return this._legacyHerokuClient
  }
}
