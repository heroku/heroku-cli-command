// @flow

import Command from 'cli-engine-command'
import OrgFlag from './org'

let env = process.env
beforeEach(() => {
  process.env = {}
})
afterEach(() => {
  process.env = env
})

describe('required', () => {
  class OrgCommand extends Command<*> {
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
      expect(err.message).toContain('Missing required flag --org')
    }
  })
})

describe('optional', () => {
  class OrgCommand extends Command<*> {
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
    class OrgCommand extends Command<*> {
      static flags = {org: OrgFlag()}
      org: ?string
      async run () {
        this.org = this.flags.org
      }
    }

    process.env.HEROKU_ORGANIZATION = 'myorg'
    const cmd = await OrgCommand.mock()
    expect(cmd.org).toEqual('myorg')
  })

  test('is hidden by default', async () => {
    expect(OrgCommand.flags.org.hidden).toBe(true)
  })

  test('does not error when org is not specified', async () => {
    await OrgCommand.mock()
  })
})
