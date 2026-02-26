import {
  Command as Base,
  Errors,
  Flags,
} from '@oclif/core'
import parser from 'yargs-parser'
import unparser from 'yargs-unparser'

import {APIClient, IOptions} from './api-client.js'
import {promptAndRun} from './prompt.js'

export abstract class Command extends Base {
  /**
   * Base flags that includes the prompt flag by default
   * Subclasses can override this to customize base flags
   */
  static baseFlags: Record<string, any> = {
    prompt: Flags.boolean({
      description: 'interactively prompt for command arguments and flags',
      helpGroup: 'GLOBAL',
    }),
  }

  /**
   * Set this to false in a command class to disable the --prompt flag for that command
   */
  static promptFlagActive = true

  allowArbitraryFlags: boolean = false

  _heroku!: APIClient

  /* eslint-disable valid-jsdoc */
  /**
   * Helper function to get baseFlags without the prompt flag
   * Use this when you want to remove the prompt flag in a specific command:
   *
   * @example
   * export default class MyCommand extends Command {
   *   static baseFlags = Command.baseFlagsWithoutPrompt()
   *   static flags = { ... }
   * }
   */
  static baseFlagsWithoutPrompt(): Record<string, any> {
    // Destructure to remove the prompt flag
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {prompt, ...rest} = this.baseFlags

    return rest
  }

  get heroku(): APIClient {
    if (this._heroku) return this._heroku
    const options: IOptions = {
      debug: process.env.HEROKU_DEBUG === '1' || process.env.HEROKU_DEBUG?.toUpperCase() === 'TRUE',
      debugHeaders: process.env.HEROKU_DEBUG_HEADERS === '1' || process.env.HEROKU_DEBUG_HEADERS?.toUpperCase() === 'TRUE',
    }
    this._heroku = new APIClient(this.config, options)
    return this._heroku
  }

  async init(): Promise<void> {
    await super.init()

    if (!this.isPromptModeActive()) {
      return
    }

    // Check if --prompt flag is present in argv
    if (!this.argv.includes('--prompt')) {
      return
    }

    // If we get here, we need to prompt for inputs
    const commandId = this.id
    if (!commandId) return

    await promptAndRun({
      argv: this.argv,
      commandId,
      config: this.config,
    })
  }

  /**
   * Returns whether prompt mode is active for this command.
   * False if the command has opted out (static promptFlagActive = false)
   * or if the prompt flag is not in baseFlags.
   */
  protected isPromptModeActive(): boolean {
    const Ctor = this.constructor as typeof Command
    if (Ctor.promptFlagActive === false) return false
    if (!('prompt' in Ctor.baseFlags)) return false
    return true
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
