import {expect, fancy} from 'fancy-test'
import nock from 'nock'

import {Command as Base} from '../../src/command.js'
import * as flags from '../../src/flags/index.js'
import {Git} from '../../src/git.js'

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
    Object.defineProperty(Git.prototype, 'remotes', {
      get() {
        throw new Error('whoa!')
      },
    })

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

describe('defaultHelp', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.HEROKU_APP
  })

  afterEach(() => {
    if (originalEnv) {
      process.env.HEROKU_APP = originalEnv
    } else {
      delete process.env.HEROKU_APP
    }
  })

  it('returns app from HEROKU_APP env var', async () => {
    process.env.HEROKU_APP = 'myapp-from-env'

    const appFlag = flags.app()
    const helpText = typeof appFlag.defaultHelp === 'function'
      ? await appFlag.defaultHelp({flags: {}, options: {name: 'app'}} as any)
      : undefined
    expect(helpText).to.equal('myapp-from-env')
  })

  it('returns app from single git remote', async () => {
    withRemotes([{name: 'heroku', url: 'https://git.heroku.com/myapp.git'}])

    const appFlag = flags.app()
    const helpText = typeof appFlag.defaultHelp === 'function'
      ? await appFlag.defaultHelp({flags: {}, options: {name: 'app'}} as any)
      : undefined
    expect(helpText).to.equal('myapp')
  })

  it('returns undefined with multiple git remotes', async () => {
    withRemotes([
      {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
      {name: 'production', url: 'https://git.heroku.com/myapp-production.git'},
    ])

    const appFlag = flags.app()
    const helpText = typeof appFlag.defaultHelp === 'function'
      ? await appFlag.defaultHelp({flags: {}, options: {name: 'app'}} as any)
      : undefined
    expect(helpText).to.be.undefined
  })

  it('returns undefined with no git remotes', async () => {
    withRemotes([])

    const appFlag = flags.app()
    const helpText = typeof appFlag.defaultHelp === 'function'
      ? await appFlag.defaultHelp({flags: {}, options: {name: 'app'}} as any)
      : undefined
    expect(helpText).to.be.undefined
  })

  it('returns app from specified remote', async () => {
    withRemotes([
      {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
      {name: 'production', url: 'https://git.heroku.com/myapp-production.git'},
    ])

    const appFlag = flags.app()
    const helpText = typeof appFlag.defaultHelp === 'function'
      ? await appFlag.defaultHelp({flags: {remote: 'production'}, options: {name: 'app'}} as any)
      : undefined
    expect(helpText).to.equal('myapp-production')
  })
})
