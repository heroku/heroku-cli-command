// @flow

import Command from 'cli-engine-command'
import TeamFlag from './team'
import OrgFlag from './org'

describe('required', () => {
  class TeamCommand extends Command {
    static flags = {team: TeamFlag({required: true})}
    team: string
    async run () {
      this.team = this.flags.team
    }
  }

  test('has an team', async () => {
    const cmd = await TeamCommand.mock('--team', 'myteam')
    expect(cmd.team).toEqual('myteam')
  })

  test('-t', async () => {
    const cmd = await TeamCommand.mock('-t', 'myteam')
    expect(cmd.team).toEqual('myteam')
  })

  test('errors with no team', async () => {
    expect.assertions(1)
    try {
      await TeamCommand.mock()
    } catch (err) {
      expect(err.message).toContain('No team specified')
    }
  })
})

describe('optional', () => {
  class TeamCommand extends Command {
    static flags = {team: TeamFlag()}
    team: ?string
    async run () {
      this.team = this.flags.team
    }
  }

  test('--team', async () => {
    const cmd = await TeamCommand.mock('--team', 'myteam')
    expect(cmd.team).toEqual('myteam')
  })

  test('-t', async () => {
    const cmd = await TeamCommand.mock('-t', 'myteam')
    expect(cmd.team).toEqual('myteam')
  })

  test('reads HEROKU_ORGANIZATION as a backup', async () => {
    class TeamCommand extends Command {
      static flags = {team: TeamFlag({}, {'HEROKU_ORGANIZATION': 'myteam'})}
      team: ?string
      async run () {
        this.team = this.flags.team
      }
    }

    const cmd = await TeamCommand.mock()
    expect(cmd.team).toEqual('myteam')
  })

  test('reads --org as a backup', async () => {
    class TeamCommand extends Command {
      static flags = {team: TeamFlag({required: true}), org: OrgFlag()}
      team: string
      async run () {
        this.team = this.flags.team
      }
    }

    const cmd = await TeamCommand.mock('--org', 'myteam')
    expect(cmd.team).toEqual('myteam')
  })

  test('reads HEROKU_TEAM', async () => {
    class TeamCommand extends Command {
      static flags = {team: TeamFlag({}, {'HEROKU_TEAM': 'myteam'})}
      team: ?string
      async run () {
        this.team = this.flags.team
      }
    }

    const cmd = await TeamCommand.mock()
    expect(cmd.team).toEqual('myteam')
  })

  test('does not error when team is not specified', async () => {
    await TeamCommand.mock()
  })
})
