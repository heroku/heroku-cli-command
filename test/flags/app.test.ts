import {expect, fancy} from 'fancy-test'
import nock from 'nock'

import {Command as Base} from '../../src'
import * as flags from '../../src/flags'
import {Git} from '../../src/git'

let api: nock.Scope
const origRemotes = Object.getOwnPropertyDescriptor(Git.prototype, 'remotes')
const withRemotes = (remotes: any) => {
  Object.defineProperty(Git.prototype, 'remotes', {get: () => remotes})
}

beforeEach(() => {
  api = nock('https://api.heroku.com')
})
afterEach(() => {
  Object.defineProperty(Git.prototype, 'remotes', origRemotes as any)
  api.done()
})

abstract class Command extends Base {
  static flags = {
    app: flags.app({required: true}),
    remote: flags.remote(),
  }
}

describe('required', () => {
  it('has an app', async () => {
    await class extends Command {
      async run() {
        const {flags} = await this.parse(Command)
        expect(flags.app).to.equal('myapp')
      }
    }.run(['--app', 'myapp'])
  })

  fancy
    .it('gets app from --remote flag', async () => {
      withRemotes([
        {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
        {name: 'production', url: 'https://git.heroku.com/myapp-production.git'},
      ])
      await class extends Command {
        async run() {
          const {flags} = await this.parse(Command)
          expect(flags.app).to.equal('myapp-staging')
        }
      }.run(['--remote', 'staging'])
    })

  it('errors if --remote not found', async () => {
    withRemotes([
      {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
      {name: 'production', url: 'https://git.heroku.com/myapp-production.git'},
    ])
    await class extends Command {
      async run() {
        await this.parse(Command).catch((error: Error) => {
          expect(error.message).to.equal('remote foo not found in git remotes')
        })
      }
    }.run(['--remote', 'foo'])
  })

  it('errors with no app', async () => {
    await class extends Command {
      async run() {
        await this.parse(Command).catch((error: Error) => {
          expect(error.message).to.contain('Missing required flag app')
        })
      }
    }.run([])
  })

  it('errors with 2 git remotes', async () => {
    withRemotes([
      {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
      {name: 'production', url: 'https://git.heroku.com/myapp-production.git'},
    ])
    await class extends Command {
      async run() {
        await this.parse(Command).catch((error: Error) => {
          expect(error.message).to.contain('Multiple apps in git remotes')
        })
      }
    }.run([])
  })

  it('returns undefined with 2 git remotes when app not required', async () => {
    withRemotes([
      {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
      {name: 'production', url: 'https://git.heroku.com/myapp-production.git'},
    ])
    await class Command extends Base {
      static flags = {
        app: flags.app(),
      } as any

      async run() {
        const {flags} = await this.parse(Command)
        expect(flags.app).to.be.undefined
      }
    }.run([])
  })

  it('gets app from git config', async () => {
    withRemotes([{name: 'heroku', url: 'https://git.heroku.com/myapp.git'}])
    await class Command extends Base {
      static flags = {
        app: flags.app(),
      } as any

      async run() {
        const {flags} = await this.parse(Command)
        expect(flags.app).to.equal('myapp')
      }
    }.run([])
  })
})

describe('optional', () => {
  it('works when git errors out', async () => {
    Object.defineProperty(Git.prototype, 'remotes', {get: () => {
      throw new Error('whoa!')
    }})

    await class Command extends Base {
      static flags = {
        app: flags.app(),
      } as any

      async run() {
        const {flags} = await this.parse(Command)
        expect(flags.app).to.be.undefined
      }
    }.run([])
  })

  it('does not error when app is not specified', async () => {
    await class Command extends Base {
      static flags = {
        app: flags.app(),
      } as any

      async run() {
        const {flags} = await this.parse(Command)
        expect(flags.app).to.be.undefined
      }
    }.run([])
  })
})
