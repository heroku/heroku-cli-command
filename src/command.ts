import {Command as Base} from '@oclif/core'
import {ArgOutput, FlagOutput, Input, ParserOutput} from '@oclif/core/lib/interfaces/parser'
import {NonExistentFlagsError} from '@oclif/core/lib/parser/errors'
import {deprecate} from 'util'
import parser from 'yargs-parser'
import unparser from 'yargs-unparser'

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
  allowArbitraryFlags: boolean = false;

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

  protected async parse<F extends FlagOutput, B extends FlagOutput, A extends ArgOutput>(options?: Input<F, B, A>, argv?: string[]): Promise<ParserOutput<F, B, A>> {
    if (this.allowArbitraryFlags) {
      try {
        return await super.parse(options, argv)
      } catch (error) {
        const {flags: nonExistentFlags} = error as NonExistentFlagsError
        const parsed = parser(this.argv)
        const nonExistentFlagsWithValues = {...parsed}

        if (nonExistentFlags && nonExistentFlags.length > 0) {
          this.warn(`Using [${nonExistentFlags}] without a '--' (end of options) preceeding them is deprecated. Please use '--' preceeding the flag(s) meant to be passed-though.`)
          for (const flag of nonExistentFlags) {
            const key = flag.replace('--', '')
            delete parsed[key]
          }
        }

        for (const key in parsed) {
          if (Reflect.has(parsed, key)) {
            delete nonExistentFlagsWithValues[key]
          }
        }

        this.argv = unparser(parsed as unparser.Arguments)
        const result = await super.parse(options, argv)
        result.nonExistentFlags = unparser(nonExistentFlagsWithValues as unparser.Arguments)

        for (let index = 0; index < result.nonExistentFlags.length; index++) {
          const positionalValue = result.nonExistentFlags[index]
          const doubleHyphenRegex = /^--/
          const positionalValueIsFlag = doubleHyphenRegex.test(positionalValue)
          if (positionalValueIsFlag) {
            const nextElement = result.nonExistentFlags[index + 1] ? result.nonExistentFlags[index + 1] : ''
            const nextElementIsFlag = doubleHyphenRegex.test(nextElement)
            // eslint-disable-next-line max-depth
            if (nextElement && !nextElementIsFlag) {
              result.argv.push(`${positionalValue}=${nextElement}`)
            } else if (!nextElement || nextElementIsFlag) {
              result.argv.push(`${positionalValue}=${true}`)
            }
          }
        }

        return result
      }
    }

    return super.parse(options, argv)
  }
}
