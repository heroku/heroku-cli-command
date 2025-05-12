import {Command, ux} from '@oclif/core'
import {expect, fancy} from 'fancy-test'

import * as flags from '../../src/flags'

describe('required', () => {
  class TeamCommand extends Command {
    static flags = {team: flags.team({required: true})}
    async run() {
      const {flags} = await this.parse(this.constructor as any)
      ux.stdout(flags.team)
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
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).to.contain('Missing required flag team')
        } else {
          throw new TypeError('Unexpected error')
        }

        done()
      }
    })
})

describe('optional', () => {
  class TeamCommand extends Command {
    static flags = {team: flags.team()}
    async run() {
      const {flags} = await this.parse(this.constructor as any)
      ux.stdout(flags.team)
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
          const {flags} = await this.parse(this.constructor as any)
          ux.stdout(flags.team)
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
          const {flags} = await this.parse(this.constructor as any)
          ux.stdout(flags.team)
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

describe('with flag/env variable priorities', () => {
  // mimics how team and org flags are setup for v5 plugins
  // https://github.com/oclif/plugin-legacy/blob/master/src/index.ts
  // #convertFlagsFromV5
  class TeamCommand extends Command {
    static flags = {
      org: flags.team({char: 'o', hidden: true}),
      team: flags.team(),
    }

    async run() {
      const {flags} = await this.parse(this.constructor as any)
      ux.stdout(flags.team)
    }
  }

  describe('when a team flag is used', function () {
    fancy
      .stdout()
      .env({HEROKU_TEAM: 'team-env'})
      .env({HEROKU_ORGANIZATION: 'org-env'})
      .it('takes priority over an org flag and environment variables', async ctx => {
        await TeamCommand.run(['-t', 'team-flag', '-o', 'org-flag'])
        expect(ctx.stdout).to.equal('team-flag\n')
      })
  })

  describe('when an org flag is used', function () {
    fancy
      .stdout()
      .env({HEROKU_TEAM: 'team-env'})
      .env({HEROKU_ORGANIZATION: 'org-env'})
      .it('takes priority over environment variables', async ctx => {
        await TeamCommand.run(['-o', 'org-flag'])
        expect(ctx.stdout).to.equal('org-flag\n')
      })
  })

  describe('when HEROKU_TEAM is used', function () {
    fancy
      .stdout()
      .env({HEROKU_TEAM: 'team-env'})
      .env({HEROKU_ORGANIZATION: 'org-env'})
      .it('takes priority over HEROKU_ORGANIZATION', async ctx => {
        await TeamCommand.run([])
        expect(ctx.stdout).to.equal('team-env\n')
      })
  })

  describe('when HEROKU_ORGANIZATION is used by itself', function () {
    fancy
      .stdout()
      .env({HEROKU_ORGANIZATION: 'org-env'})
      .it('is is shown', async ctx => {
        await TeamCommand.run([])
        expect(ctx.stdout).to.equal('org-env\n')
      })
  })
})
