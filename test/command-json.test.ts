import {Config} from '@oclif/core/config'
import * as OclifFlags from '@oclif/core/flags'
import {ux} from '@oclif/core/ux'
import {expect} from 'fancy-test'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import * as sinon from 'sinon'

import {Command} from '../src/command.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LEGACY_TOKEN = '01234567-89ab-cdef-0123-456789abcdef'

class JsonCommand extends Command {
  static enableJsonFlag = true
  static flags = {
    app: OclifFlags.string(),
  }

  async run() {
    await this.parse(JsonCommand)
    return {ok: true}
  }
}

class FailingCommand extends Command {
  static enableJsonFlag = true

  async run() {
    await this.parse(FailingCommand)
    throw new Error(`request with ${LEGACY_TOKEN} failed`)
  }
}

class SpinnerCommand extends Command {
  static enableJsonFlag = true

  async run() {
    await this.parse(SpinnerCommand)
    ux.action.start('working')
    ux.action.status = 'still working'
    await ux.action.pauseAsync(async () => {})
    ux.action.stop()
    ux.action.start('working again')
    throw new Error('spinner failed')
  }
}

class ShortCommand extends Command {
  static enableJsonFlag = true
  static flags = {
    short: OclifFlags.boolean({allowNo: true, char: 's'}),
  }

  static jsonSuppressedBy: Array<keyof typeof ShortCommand.flags> = ['short']

  async run() {
    const {flags} = await this.parse(ShortCommand)
    if (flags.short) this.log('raw-token')
    return {token: 'in-json'}
  }
}

class UndeclaredShortCommand extends Command {
  static enableJsonFlag = true
  static flags = {
    short: OclifFlags.boolean({char: 's'}),
  }

  async run() {
    await this.parse(UndeclaredShortCommand)
    return {token: 'in-json'}
  }
}

type Output = {stderr: string; stdout: string}

/**
 * Runs the command through oclif's lifecycle (init, run, catch, finally) and captures output.
 * Uses the loaded Config as is: the static `Command.run` reloads it.
 */
async function run(Cmd: typeof Command, argv: string[], config: Config): Promise<Output & {error?: Error}> {
  const output = {stderr: '', stdout: ''}
  const stdout = sinon.stub(process.stdout, 'write').callsFake(chunk => {
    output.stdout += String(chunk)
    return true
  })
  const stderr = sinon.stub(process.stderr, 'write').callsFake(chunk => {
    output.stderr += String(chunk)
    return true
  })
  let error: Error | undefined
  try {
    const Ctor = Cmd as unknown as new (argv: string[], config: Config) => Command & {_run(): Promise<unknown>}
    await new Ctor(argv, config)._run()
  } catch (error_) {
    error = error_ as Error
  } finally {
    stdout.restore()
    stderr.restore()
  }

  return {...output, error}
}

describe('command --json', () => {
  const {env} = process
  let config: Config

  before(async () => {
    config = await Config.load({root: path.resolve(__dirname, '../package.json')})
  })

  beforeEach(() => {
    // Keep the platform environment (Windows needs it) but none of the variables these tests set.
    // HEROKU_API_KEY loads the token without reading credential storage.
    process.env = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(HEROKU_|DEBUG$)/.test(name)))
    process.env.HEROKU_API_KEY = LEGACY_TOKEN
    process.exitCode = undefined
  })

  afterEach(() => {
    // Restore any stdout/stderr stub a timed-out test left behind.
    sinon.restore()
    process.env = env
    process.exitCode = undefined
  })

  describe('error documents', () => {
    it('renders a parse error without the parser context or the token', async () => {
      const {error, stdout} = await run(JsonCommand, ['--json', '--bogus'], config)
      expect(error).to.equal(undefined)
      const document = JSON.parse(stdout)
      expect(document.error).to.include({exitCode: 1, name: 'Error'})
      expect(document.error.message).to.contain('--bogus')
      expect(document.error).to.not.have.any.keys('parse', 'oclif')
      expect(stdout).to.not.contain(LEGACY_TOKEN)
      expect(stdout.length).to.be.below(1024)
    })

    it('redacts the loaded token from the error message', async () => {
      const {stdout} = await run(FailingCommand, ['--json'], config)
      const {error} = JSON.parse(stdout)
      expect(error.message).to.equal('request with [REDACTED] failed')
    })

    it('writes the full redacted error to stderr under HEROKU_DEBUG, leaving stdout the document', async () => {
      process.env.HEROKU_DEBUG = '1'
      const {stderr, stdout} = await run(FailingCommand, ['--json'], config)
      expect(Object.keys(JSON.parse(stdout))).to.deep.equal(['error'])
      expect(stderr).to.contain('at ')
      expect(stderr).to.contain('[REDACTED]')
      expect(stderr).to.not.contain(LEGACY_TOKEN)
    })

    it('writes nothing to stderr without debug', async () => {
      const {stderr} = await run(FailingCommand, ['--json'], config)
      expect(stderr).to.equal('')
    })
  })

  describe('spinners', () => {
    it('keeps spinners quiet and still writes the error document', async () => {
      const {stderr, stdout} = await run(SpinnerCommand, ['--json'], config)
      expect(stderr).to.equal('')
      expect(JSON.parse(stdout).error.message).to.equal('spinner failed')
    })

    it('restores ux.action after the command', async () => {
      await run(SpinnerCommand, ['--json'], config)
      expect(Object.hasOwn(ux.action, 'start')).to.equal(false)
      expect(Object.hasOwn(ux.action, 'stop')).to.equal(false)
    })

    it('leaves spinners alone without --json', async () => {
      const {error, stderr} = await run(SpinnerCommand, [], config)
      expect(error?.message).to.equal('spinner failed')
      expect(stderr).to.contain('working')
    })

    it('stops a spinner that is already running so the document is written', async () => {
      const output = {stdout: ''}
      const stdout = sinon.stub(process.stdout, 'write').callsFake(chunk => {
        output.stdout += String(chunk)
        return true
      })
      const stderr = sinon.stub(process.stderr, 'write').returns(true)
      let written: string | undefined
      try {
        const cmd = new JsonCommand(['--json'], config)
        ux.action.start('started elsewhere')
        await cmd.catch(new Error('boom'))
        // Read before cleanup: stopping the spinner below would flush anything it buffered.
        written = output.stdout
      } finally {
        if (ux.action.running) ux.action.stop()
        stdout.restore()
        stderr.restore()
      }

      expect(written).to.contain('"message": "boom"')
    })
  })

  describe('jsonSuppressedBy', () => {
    it('prints raw output when the flag is set', async () => {
      const {stdout} = await run(ShortCommand, ['--json', '--short'], config)
      expect(stdout).to.equal('raw-token\n')
    })

    it('prints raw output for the flag character', async () => {
      const {stdout} = await run(ShortCommand, ['--json', '-s'], config)
      expect(stdout).to.equal('raw-token\n')
    })

    it('prints raw output under HEROKU_CONTENT_TYPE=json', async () => {
      process.env[config.scopedEnvVarKey('CONTENT_TYPE')] = 'json'
      const {stdout} = await run(ShortCommand, ['--short'], config)
      expect(stdout).to.equal('raw-token\n')
    })

    it('prints JSON when the flag is negated', async () => {
      const {stdout} = await run(ShortCommand, ['--json', '--no-short'], config)
      expect(JSON.parse(stdout)).to.deep.equal({token: 'in-json'})
    })

    it('prints JSON when the flag is not set', async () => {
      const {stdout} = await run(ShortCommand, ['--json'], config)
      expect(JSON.parse(stdout)).to.deep.equal({token: 'in-json'})
    })

    it('ignores the same flag on a command that does not declare it', async () => {
      const {stdout} = await run(UndeclaredShortCommand, ['--json', '--short'], config)
      expect(JSON.parse(stdout)).to.deep.equal({token: 'in-json'})
    })

    it('renders a parse error as text when the flag is on the command line', async () => {
      const {error, stdout} = await run(ShortCommand, ['--json', '--short', '--bogus'], config)
      expect(error?.message).to.contain('--bogus')
      expect(stdout).to.equal('')
    })

    it('ignores the flag after -- when scanning argv', async () => {
      const {error, stdout} = await run(ShortCommand, ['--json', '--bogus', '--', '--short'], config)
      expect(error).to.equal(undefined)
      expect(JSON.parse(stdout).error.message).to.contain('--bogus')
    })
  })
})
