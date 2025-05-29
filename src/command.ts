import {Command as Base} from '@oclif/core'
import {Errors} from '@oclif/core'
import parser from 'yargs-parser'
import unparser from 'yargs-unparser'

import {APIClient, IOptions} from './api-client.js'

export abstract class Command extends Base {
  allowArbitraryFlags: boolean = false
  _heroku!: APIClient

  get heroku(): APIClient {
    if (this._heroku) return this._heroku
    const options: IOptions = {
      debug: process.env.HEROKU_DEBUG === '1' || process.env.HEROKU_DEBUG?.toUpperCase() === 'TRUE',
      debugHeaders: process.env.HEROKU_DEBUG_HEADERS === '1' || process.env.HEROKU_DEBUG_HEADERS?.toUpperCase() === 'TRUE',
    }
    this._heroku = new APIClient(this.config, options)
    return this._heroku
  }

  protected async parse(options?: any, argv?: string[]): Promise<any> {
    if (this.allowArbitraryFlags) {
      try {
        return await super.parse(options, argv)
      } catch (error) {
        const {flags: nonExistentFlags} = error as {flags: string[]} & Errors.CLIError
        const parsed = parser(this.argv)
        const nonExistentFlagsWithValues = {...parsed}

        if (nonExistentFlags && nonExistentFlags.length > 0) {
          this.warn(`You're using a deprecated syntax with the [${nonExistentFlags}] flag.\nAdd a '--' (end of options) separator before the flags you're passing through.`)
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
            const nextElement = result.nonExistentFlags[index + 1] ?? ''
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
