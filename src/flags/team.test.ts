import { Command } from '@cli-engine/command'

import * as flags from '.'

let env = process.env
let teamfn: jest.Mock<{}>
beforeEach(() => {
  process.env = {}
  teamfn = jest.fn()
})
afterEach(() => {
  process.env = env
})

describe('required', () => {
  class TeamCommand extends Command {
    static flags = { team: flags.team({ required: true }) }
    async run() {
      teamfn(this.flags.team)
    }
  }

  test('has an team', async () => {
    await TeamCommand.mock(['--team', 'myteam'])
    expect(teamfn).toBeCalledWith('myteam')
  })

  test('-t', async () => {
    await TeamCommand.mock(['-t', 'myteam'])
    expect(teamfn).toBeCalledWith('myteam')
  })

  test('errors with no team', async () => {
    expect.assertions(1)
    try {
      await TeamCommand.mock()
    } catch (err) {
      expect(err.message).toContain('Missing required flag:\n -t, --team TEAM')
    }
  })
})

describe('optional', () => {
  class TeamCommand extends Command {
    static flags = { team: flags.team() }
    async run() {
      teamfn(this.flags.team)
    }
  }

  test('--team', async () => {
    await TeamCommand.mock(['--team', 'myteam'])
    expect(teamfn).toBeCalledWith('myteam')
  })

  test('-t', async () => {
    await TeamCommand.mock(['-t', 'myteam'])
    expect(teamfn).toBeCalledWith('myteam')
  })

  test('reads HEROKU_ORGANIZATION as a backup', async () => {
    class TeamCommand extends Command {
      static flags = { team: flags.team() }
      async run() {
        teamfn(this.flags.team)
      }
    }

    process.env.HEROKU_ORGANIZATION = 'myenvteam'
    await TeamCommand.mock()
    expect(teamfn).toBeCalledWith('myenvteam')
  })

  test('reads --org as a backup', async () => {
    class TeamCommand extends Command {
      static flags = { team: flags.team({ required: true }), org: flags.org() }
      team: string
      async run() {
        teamfn(this.flags.team)
      }
    }

    await TeamCommand.mock(['--org', 'myteam'])
    expect(teamfn).toBeCalledWith('myteam')
  })

  test('reads HEROKU_TEAM', async () => {
    class TeamCommand extends Command {
      static flags = { team: flags.team() }
      async run() {
        teamfn(this.flags.team)
      }
    }

    process.env.HEROKU_TEAM = 'myteam'
    await TeamCommand.mock()
    expect(teamfn).toBeCalledWith('myteam')
  })

  test('does not error when team is not specified', async () => {
    await TeamCommand.mock()
  })
})
