import {Command as Base} from '@oclif/core'
import {deprecate} from 'util'

const pjson = require('../package.json')

import {APIClient} from './api-client'
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
    this._heroku = new deps.APIClient(this.config)
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
yarn add @heroku-cli/command
 yarn add -D @heroku-cli/schema.
   // note that we are using @heroku-cli/command instead of @oclif/command
// this inherits from @oclif/command but extends it with Heroku-specific functionality
import {Command, flags} from '@heroku-cli/command'
import * as Heroku from '@heroku-cli/schema'

export default class AppCommand extends Command {
  static description = 'say hi to an app'
  static flags = {
    remote: flags.remote(),
    app: flags.app({required: true})
  }

  async run () {
    const {flags} = await this.parse(AppCommand)
    const response = await this.heroku.get<Heroku.App>(`/apps/${flags.app}`)
    const app = response.body
    console.dir(app)
  }
}
heroku plugins:install,
  $ npm login
Username: jdxcode
Password:
Email: (this IS public) npm@heroku.com
Logged in as jdxcode on https://registry.npmjs.org/



