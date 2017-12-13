import { Command } from 'cli-engine-command'
import { flags } from '.'
import { cli } from 'cli-ux'

let env = process.env
beforeEach(() => {
  process.env = {}
})
afterEach(() => {
  process.env = env
})

describe('required', () => {
  class OrgCommand extends Command {
    static flags = { org: flags.org({ required: true }) }
    async run() {
      cli.log(this.flags.org)
    }
  }

  test('has an org', async () => {
    const { stdout } = await OrgCommand.mock('--org', 'myorg')
    expect(stdout).toEqual('myorg\n')
  })

  test('errors with no org', async () => {
    expect.assertions(1)
    try {
      await OrgCommand.mock()
    } catch (err) {
      expect(err.message).toContain('Missing required flag:\n -o, --org')
    }
  })
})

describe('optional', () => {
  class OrgCommand extends Command {
    static flags = { org: flags.org() }
    async run() {
      cli.log(this.flags.org)
    }
  }

  test('--org', async () => {
    await OrgCommand.mock('--org', 'myorg')
    expect(cli.stdout.output).toEqual('myorg\n')
  })

  test('-o', async () => {
    await OrgCommand.mock('-o', 'myorg')
    expect(cli.stdout.output).toEqual('myorg\n')
  })

  test('reads HEROKU_ORGANIZATION', async () => {
    class OrgCommand extends Command {
      static flags = { org: flags.org() }
      async run() {
        cli.log(this.flags.org)
      }
    }

    process.env.HEROKU_ORGANIZATION = 'myorg'
    await OrgCommand.mock()
    expect(cli.stdout.output).toEqual('myorg\n')
  })

  test('is hidden by default', async () => {
    expect(flags.org().hidden).toBe(true)
  })

  test('does not error when org is not specified', async () => {
    await OrgCommand.mock()
  })
})
