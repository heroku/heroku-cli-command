import {Command} from '@oclif/command'
import {cli} from 'cli-ux'
import {expect, fancy} from 'fancy-test'

import * as flags from '../../src/flags'

describe('required', () => {
  class OrgCommand extends Command {
    static flags = {org: flags.org({required: true})}
    async run() {
      const {flags} = this.parse(this.constructor as any)
      cli.log(flags.org)
    }
  }

  fancy
  .stdout()
  .it('has an org', async ctx => {
    await OrgCommand.run(['--org', 'myorg'])
    expect(ctx.stdout).to.equal('myorg\n')
  })

  fancy
  .it('errors with no org', async (_, done) => {
    try {
      await OrgCommand.run([])
    } catch (err) {
      expect(err.message).to.contain('Missing required flag:\n -o, --org')
      done()
    }
  })
})

describe('optional', () => {
  class OrgCommand extends Command {
    static flags = {org: flags.org()}
    async run() {
      const {flags} = this.parse(this.constructor as any)
      cli.log(flags.org)
    }
  }

  fancy
  .stdout()
  .it('--org', async ctx => {
    await OrgCommand.run(['--org', 'myorg'])
    expect(ctx.stdout).to.equal('myorg\n')
  })

  fancy
  .stdout()
  .it('-o', async ctx => {
    await OrgCommand.run(['-o', 'myorg'])
    expect(ctx.stdout).to.equal('myorg\n')
  })

  fancy
  .stdout()
  .env({HEROKU_ORGANIZATION: 'myorg'})
  .it('reads HEROKU_ORGANIZATION', async ctx => {
    class OrgCommand extends Command {
      static flags = {org: flags.org()}
      async run() {
        const {flags} = this.parse(this.constructor as any)
        cli.log(flags.org)
      }
    }

    await OrgCommand.run([])
    expect(ctx.stdout).to.equal('myorg\n')
  })

  it('is hidden by default', async () => {
    expect(flags.org().hidden).to.be.ok
  })

  fancy
  .stdout()
  .it('does not error when org is not specified', async () => {
    await OrgCommand.run([])
  })
})
