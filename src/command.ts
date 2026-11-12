import type {Input, ParserOutput} from '@oclif/core/interfaces'

import {Command as Base} from '@oclif/core/command'
import * as Flags from '@oclif/core/flags'
import {ux} from '@oclif/core/ux'

import {APIClient, type IOptions} from './api-client.js'
import {debugErrorText, type ErrorDocument, toErrorDocument} from './error-document.js'
import {quietSpinners} from './quiet-spinners.js'

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
   * Flags on this command that print raw output, such as a flag that prints only
   * a token. When one is set, JSON output is off, even under `--json` or
   * `HEROKU_CONTENT_TYPE=json`. Only this command's own declaration counts: the
   * same flag name on another command has no effect. Type it against the
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
      debug: process.env.HEROKU_DEBUG === '1' || process.env.HEROKU_DEBUG?.toUpperCase() === 'TRUE',
      debugHeaders: process.env.HEROKU_DEBUG_HEADERS === '1' || process.env.HEROKU_DEBUG_HEADERS?.toUpperCase() === 'TRUE',
    }
    this._heroku = new APIClient(this.config, options)
    return this._heroku
  }

  /**
   * Stops a running spinner before oclif renders the error. oclif stops it only
   * when JSON output is off, and a running spinner buffers stdout, so the
   * `--json` error document would otherwise never be written.
   */
  async catch(err: Error & {exitCode?: number}): Promise<any> {
    try {
      if (ux.action.running) ux.action.stop(ux.colorize('bold', ux.colorize('red', '!')))
    } catch {}

    if (this.jsonEnabled() && isDebugEnabled()) {
      process.stderr.write(`${debugErrorText(err, this.knownSecrets())}\n`)
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
    return output
  }

  /**
   * The `--json` error document, the same for every command: an allowlisted set
   * of fields with secrets redacted. See {@link ErrorDocument}.
   */
  public toErrorJson(err: unknown): {error: ErrorDocument} {
    const fromError = (err as undefined | {exitCode?: unknown})?.exitCode
    // Report the code the process exits with: oclif's catch() sets process.exitCode
    // from the same sources before rendering the document.
    const exitCode = Number(process.exitCode ?? (typeof fromError === 'number' ? fromError : 1))
    return {error: toErrorDocument(err, {exitCode, secrets: this.knownSecrets()})}
  }

  /**
   * Whether a flag in {@link Command.jsonSuppressedBy} is set. After parsing, the
   * parsed flags decide, so aliases, `--no-<flag>` and the `--` passthrough are
   * handled by the parser. Before parsing (an error in init() or in parsing
   * itself), argv is scanned up to `--` for `--name`, `--name=value`, an alias,
   * or the flag's `-c` character.
   */
  private jsonSuppressed(): boolean {
    const Ctor = this.constructor as typeof Command
    const names = Ctor.jsonSuppressedBy
    if (names.length === 0) return false

    if (this.parsedFlags) {
      return names.some(name => {
        const value = this.parsedFlags?.[name]
        return value !== undefined && value !== false
      })
    }

    const passThrough = this.argv.indexOf('--')
    const argv = passThrough === -1 ? this.argv : this.argv.slice(0, passThrough)
    return names.some(name => {
      const flag = (Ctor.flags as Record<string, {aliases?: string[]; char?: string; charAliases?: string[]}> | undefined)?.[name]
      const longNames = [name, ...(flag?.aliases ?? [])].map(n => `--${n}`)
      const chars = new Set([flag?.char, ...(flag?.charAliases ?? [])].filter(Boolean).map(c => `-${c}`))
      return argv.some(arg => longNames.some(n => arg === n || arg.startsWith(`${n}=`)) || chars.has(arg))
    })
  }
}

function isDebugEnabled(): boolean {
  const herokuDebug = process.env.HEROKU_DEBUG?.toLowerCase()
  return Boolean(process.env.DEBUG) || herokuDebug === '1' || herokuDebug === 'true'
}
