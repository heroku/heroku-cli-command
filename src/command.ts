import {Command as Base} from '@oclif/core/command'
import * as Flags from '@oclif/core/flags'

import {APIClient, type IOptions} from './api-client.js'

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
  _heroku!: APIClient

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

    // Preload credentials so this.heroku.auth is set before run() (async credential-manager + sync checks).
    await this.heroku.getAuth()

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

    const {promptAndRun} = await import('./prompt.js')
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
    return Ctor.promptFlagActive && ('prompt' in Ctor.baseFlags)
  }
}
