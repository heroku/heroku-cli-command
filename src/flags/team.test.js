// @flow

import Command from 'cli-engine-command'
import flags from '.'

let env = process.env
beforeEach(() => {
  process.env = {}
})
afterEach(() => {
  process.env = env
})

function fetchErr (cmd): Error {
  if (!cmd.err) throw new Error('no error')
  return cmd.err
}

describe('required', () => {
  class TeamCommand extends Command<*> {
    static flags = {team: flags.team({required: true})}
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
    const cmd = await TeamCommand.mock()
    expect(fetchErr(cmd).message).toContain('No team specified')
  })
})

describe('optional', () => {
  class TeamCommand extends Command<*> {
    static flags = {team: flags.team()}
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
    class TeamCommand extends Command<*> {
      static flags = {team: flags.team()}
      team: ?string
      async run () {
        this.team = this.flags.team
      }
    }

    process.env.HEROKU_ORGANIZATION = 'myenvteam'
    const cmd = await TeamCommand.mock()
    expect(cmd.team).toEqual('myenvteam')
  })

  test('reads --org as a backup', async () => {
    class TeamCommand extends Command<*> {
      static flags = {team: flags.team({required: true}), org: flags.org()}
      team: string
      async run () {
        this.team = this.flags.team
      }
    }

    const cmd = await TeamCommand.mock('--org', 'myteam')
    expect(cmd.team).toEqual('myteam')
  })

  test('reads HEROKU_TEAM', async () => {
    class TeamCommand extends Command<*> {
      static flags = {team: flags.team()}
      team: ?string
      async run () {
        this.team = this.flags.team
      }
    }

    process.env.HEROKU_TEAM = 'myteam'
    const cmd = await TeamCommand.mock()
    expect(cmd.team).toEqual('myteam')
  })

  test('does not error when team is not specified', async () => {
    await TeamCommand.mock()
  })
})
