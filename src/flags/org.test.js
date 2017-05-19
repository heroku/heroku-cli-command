// @flow

import Command from 'cli-engine-command'
import OrgFlag from './org'
import TeamFlag from './team'

describe('required', () => {
  class OrgCommand extends Command {
    static flags = {org: OrgFlag({required: true})}
    org: string
    async run () {
      this.org = this.flags.org
    }
  }

  test('has an org', async () => {
    const cmd = await OrgCommand.mock('--org', 'myorg')
    expect(cmd.org).toEqual('myorg')
  })

  test('errors with no org', async () => {
    expect.assertions(1)
    try {
      await OrgCommand.mock()
    } catch (err) {
      expect(err.message).toContain('No org specified')
    }
  })
})

describe('optional', () => {
  class OrgCommand extends Command {
    static flags = {org: OrgFlag()}
    org: ?string
    async run () {
      this.org = this.flags.org
    }
  }

  test('--org', async () => {
    const cmd = await OrgCommand.mock('--org', 'myorg')
    expect(cmd.org).toEqual('myorg')
  })

  test('-o', async () => {
    const cmd = await OrgCommand.mock('-o', 'myorg')
    expect(cmd.org).toEqual('myorg')
  })

  test('reads HEROKU_ORGANIZATION', async () => {
    class OrgCommand extends Command {
      static flags = {org: OrgFlag({}, {'HEROKU_ORGANIZATION': 'myorg'})}
      org: ?string
      async run () {
        this.org = this.flags.org
      }
    }

    const cmd = await OrgCommand.mock()
    expect(cmd.org).toEqual('myorg')
  })

  test('reads --flag as a backup', async () => {
    class OrgCommand extends Command {
      static flags = {org: OrgFlag({required: true}), team: TeamFlag()}
      org: string
      async run () {
        this.org = this.flags.org
      }
    }

    const cmd = await OrgCommand.mock('--team', 'myorg')
    expect(cmd.org).toEqual('myorg')
  })

  test('does not error when org is not specified', async () => {
    await OrgCommand.mock()
  })
})
