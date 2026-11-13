import type {Input, ParserOutput} from '@oclif/core/interfaces'

import {Command as Base} from '@oclif/core/command'
import {CLIError} from '@oclif/core/errors'
import * as Flags from '@oclif/core/flags'
import {ux} from '@oclif/core/ux'

import {APIClient, type IOptions} from './api-client.js'
import {
  debugErrorText,
  type JsonErrorDocument,
  toError,
  toJsonErrorDocument,
} from './json-error-document.js'
import {quietSpinners} from './quiet-spinners.js'

/** The `code` of the error for `--prompt` under JSON output. */
export const PROMPT_WITH_JSON_ERROR_CODE = 'HEROKU_PROMPT_WITH_JSON'

export abstract class Command extends Base {
  /**
   * Base flags that includes the prompt flag by default
   * Subclasses can override this to customize base flags
   */
  static baseFlags: Record<string, any> = {
    prompt: Flags.boolean({
      description: 'interactively prompt for command arguments and flags',
      // Enforced in init(), before any prompt; this only documents the conflict.
      exclusive: ['json'],
      helpGroup: 'GLOBAL',
    }),
  }

  /**
   * Flags on this command that print raw output, such as a flag that prints only
   * a token. When one is set, JSON output is off, even under `--json` or
   * `HEROKU_CONTENT_TYPE=json`. Only this command's own declaration counts: the
   * same flag name on another command has no effect. The parsed flags decide,
   * so an error before or during parsing is still a JSON document, and a value
   * that comes from the flag's `default` doesn't count. Type it against the
   * command's flags so a typo fails to compile:
   *
   * @example
   * static jsonSuppressedBy: Array<keyof typeof MyCommand.flags> = ['short']
   */
  static jsonSuppressedBy: readonly string[] = []

  /**
   * Set this to false in a command class to disable the --prompt flag for that command
   */
  static promptFlagActive = true
  _heroku!: APIClient

  private parsedFlagMetadata?: Record<string, {setFromDefault?: boolean}>
  private parsedFlags?: Record<string, unknown>
  private restoreSpinners?: () => void

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
      debug: isEnvTrue('HEROKU_DEBUG'),
      debugHeaders: isEnvTrue('HEROKU_DEBUG_HEADERS'),
    }
    this._heroku = new APIClient(this.config, options)
    return this._heroku
  }

  /**
   * Stops a running spinner before oclif renders the error. oclif stops it only
   * when JSON output is off, and a running spinner buffers stdout, so the
   * `--json` error document would otherwise never be written.
   */
  async catch(thrown: Error & {exitCode?: number}): Promise<any> {
    // oclif's catch() reads properties of the thrown value, so `throw undefined` would crash it.
    const err = toError(thrown) as CLIError & {exitCode?: number}
    try {
      if (ux.action.running) ux.action.stop(ux.colorize('bold', ux.colorize('red', '!')))
    } catch {}

    if (this.jsonEnabled()) {
      // this.exit() and ux.exit() aren't failures to report: the exit code says it all.
      if (err.code === 'EEXIT') {
        process.exitCode ??= err.oclif?.exit ?? 0
        return
      }

      if (isEnvTrue('HEROKU_DEBUG')) process.stderr.write(`${debugErrorText(err, this.knownSecrets())}\n`)
    }

    return super.catch(err)
  }

  async finally(err: Error | undefined): Promise<any> {
    this.restoreSpinners?.()
    this.restoreSpinners = undefined
    return super.finally(err)
  }

  async init(): Promise<void> {
    await super.init()

    // Under JSON output, spinners write nothing and never take over stdout/stderr.
    if (this.jsonEnabled()) this.restoreSpinners = quietSpinners()

    // Preload credentials so this.heroku.auth is set before run() (async credential-manager + sync checks).
    await this.heroku.getAuth()

    if (!this.isPromptModeActive()) {
      return
    }

    // Check if --prompt flag is present in argv
    if (!this.argv.includes('--prompt')) {
      return
    }

    // Prompts wait for answers a script will never type. Checked here because prompting runs
    // before parse() enforces `exclusive`, and HEROKU_CONTENT_TYPE=json sets no flag at all.
    if (this.jsonEnabled()) {
      throw new CLIError('--prompt can\'t be used with --json. Pass the arguments and flags on the command line.', {
        code: PROMPT_WITH_JSON_ERROR_CODE,
      })
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

  /**
   * Whether JSON output is on: oclif's rule (`--json` or `HEROKU_CONTENT_TYPE=json`),
   * unless a flag in {@link Command.jsonSuppressedBy} is set.
   */
  public jsonEnabled(): boolean {
    return super.jsonEnabled() && !this.jsonSuppressed()
  }

  /** The current API token and HEROKU_API_KEY, redacted wherever they appear in error output. */
  protected knownSecrets(): Array<string | undefined> {
    return [this._heroku?.auth, process.env.HEROKU_API_KEY]
  }

  protected async parse<F extends Record<string, any>, B extends Record<string, any>, A extends Record<string, any>>(
    options?: Input<F, B, A>,
    argv?: string[],
  ): Promise<ParserOutput<F, B, A>> {
    const output = await super.parse<F, B, A>(options, argv)
    this.parsedFlags = output.flags
    this.parsedFlagMetadata = output.metadata.flags
    return output
  }

  /**
   * The `--json` error document, the same for every command: an allowlisted set
   * of fields with secrets redacted. See {@link JsonErrorDocument}.
   */
  public toErrorJson(err: unknown): {error: JsonErrorDocument} {
    const fromError = (err as undefined | {exitCode?: unknown})?.exitCode
    // Report the code the process exits with: oclif's catch() sets process.exitCode
    // from the same sources before rendering the document.
    const exitCode = Number(process.exitCode ?? (typeof fromError === 'number' ? fromError : 1))
    return {error: toJsonErrorDocument(err, {exitCode, secrets: this.knownSecrets()})}
  }

  /**
   * Whether a flag in {@link Command.jsonSuppressedBy} is set on the command line
   * or by its environment variable. Always false before parsing.
   */
  private jsonSuppressed(): boolean {
    const {jsonSuppressedBy} = this.constructor as typeof Command
    return jsonSuppressedBy.some(name => {
      const value = this.parsedFlags?.[name]
      return value !== undefined && value !== false && !this.parsedFlagMetadata?.[name]?.setFromDefault
    })
  }
}

/** Whether the environment variable is `1` or `true`, in any case. */
function isEnvTrue(name: string): boolean {
  const value = process.env[name]?.toLowerCase()
  return value === '1' || value === 'true'
}
