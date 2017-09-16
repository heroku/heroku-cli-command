import { Command } from 'cli-engine-command'
import { flags } from '.'

let env = process.env
beforeEach(() => {
  process.env = {}
})
afterEach(() => {
  process.env = env
})

describe('required', () => {
  class OrgCommand extends Command {
    options = {
      flags: { org: flags.org({ required: true }) },
    }
    async run() {
      this.cli.log(this.flags.org)
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
    options = {
      flags: { org: flags.org() },
    }
    async run() {
      this.cli.log(this.flags.org)
    }
  }

  test('--org', async () => {
    const { stdout } = await OrgCommand.mock('--org', 'myorg')
    expect(stdout).toEqual('myorg\n')
  })

  test('-o', async () => {
    const { stdout } = await OrgCommand.mock('-o', 'myorg')
    expect(stdout).toEqual('myorg\n')
  })

  test('reads HEROKU_ORGANIZATION', async () => {
    class OrgCommand extends Command {
      options = {
        flags: { org: flags.org() },
      }
      async run() {
        this.cli.log(this.flags.org)
      }
    }

    process.env.HEROKU_ORGANIZATION = 'myorg'
    const { stdout } = await OrgCommand.mock()
    expect(stdout).toEqual('myorg\n')
  })

  test('is hidden by default', async () => {
    expect(flags.org().hidden).toBe(true)
  })

  test('does not error when org is not specified', async () => {
    await OrgCommand.mock()
  })
})
