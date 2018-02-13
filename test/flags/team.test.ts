import {Command} from '@oclif/command'
import {cli} from 'cli-ux'
import {expect, fancy} from 'fancy-test'

import * as flags from '../../src/flags'

describe('required', () => {
  class TeamCommand extends Command {
    static flags = {team: flags.team({required: true})}
    async run() {
      const {flags} = this.parse(this.constructor as any)
      cli.log(flags.team)
    }
  }

  fancy
  .stdout()
  .it('has an team', async ctx => {
    await TeamCommand.run(['--team', 'myteam'])
    expect(ctx.stdout).to.equal('myteam\n')
  })

  fancy
  .it('errors with no team', async (_, done) => {
    try {
      await TeamCommand.run([])
    } catch (err) {
      expect(err.message).to.contain('Missing required flag:\n -t, --team')
      done()
    }
  })
})

describe('optional', () => {
  class TeamCommand extends Command {
    static flags = {team: flags.team()}
    async run() {
      const {flags} = this.parse(this.constructor as any)
      cli.log(flags.team)
    }
  }

  fancy
  .stdout()
  .it('--team', async ctx => {
    await TeamCommand.run(['--team', 'myteam'])
    expect(ctx.stdout).to.equal('myteam\n')
  })

  fancy
  .stdout()
  .it('-t', async ctx => {
    await TeamCommand.run(['-t', 'myteam'])
    expect(ctx.stdout).to.equal('myteam\n')
  })

  fancy
  .stdout()
  .env({HEROKU_ORGANIZATION: 'myteam'})
  .it('reads HEROKU_ORGANIZATION', async ctx => {
    class TeamCommand extends Command {
      static flags = {team: flags.team()}
      async run() {
        const {flags} = this.parse(this.constructor as any)
        cli.log(flags.team)
      }
    }

    await TeamCommand.run([])
    expect(ctx.stdout).to.equal('myteam\n')
  })

  fancy
  .stdout()
  .env({HEROKU_TEAM: 'myteam'})
  .it('reads HEROKU_TEAM', async ctx => {
    class TeamCommand extends Command {
      static flags = {team: flags.team()}
      async run() {
        const {flags} = this.parse(this.constructor as any)
        cli.log(flags.team)
      }
    }

    await TeamCommand.run([])
    expect(ctx.stdout).to.equal('myteam\n')
  })

  fancy
  .stdout()
  .it('does not error when team is not specified', async () => {
    await TeamCommand.run([])
  })
})
