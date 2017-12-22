import { defaultConfig as config } from 'cli-engine-config'
import * as nock from 'nock'
import { Command as Base } from '../command'
import * as flags from './app'

let mockGitRemotes = jest.fn()

jest.mock('../git', () => ({
  Git: class {
    get remotes() {
      return mockGitRemotes()
    }
  },
}))

let api: nock.Scope
let appfn: jest.Mock<any>
beforeEach(() => {
  mockGitRemotes.mockReturnValue([])
  api = nock('https://api.heroku.com')
  appfn = jest.fn()
})
afterEach(() => {
  api.done()
})

describe('required', () => {
  class Command extends Base {
    static flags = { app: flags.app({ required: true }), remote: flags.remote() }

    async run() {
      appfn(this.flags.app)
    }
  }

  test('has an app', async () => {
    await Command.mock(['--app', 'myapp'])
    expect(appfn).toBeCalledWith('myapp')
  })

  test('gets app from --remote flag', async () => {
    mockGitRemotes.mockReturnValueOnce([
      { name: 'staging', url: 'https://git.heroku.com/myapp-staging.git' },
      { name: 'production', url: 'https://git.heroku.com/myapp-production.git' },
    ])
    await Command.mock(['-r', 'staging'])
    expect(appfn).toBeCalledWith('myapp-staging')
  })

  test('errors if --remote not found', async () => {
    expect.assertions(1)
    mockGitRemotes.mockReturnValueOnce([
      { name: 'staging', url: 'https://git.heroku.com/myapp-staging.git' },
      { name: 'production', url: 'https://git.heroku.com/myapp-production.git' },
    ])
    try {
      await Command.mock(['-r', 'foo'])
    } catch (err) {
      expect(err.message).toEqual('remote foo not found in git remotes')
    }
  })

  test('errors with no app', async () => {
    expect.assertions(1)
    try {
      await Command.mock()
    } catch (err) {
      expect(err.message).toContain('Missing required flag:\n -a, --app')
    }
  })

  test('errors with 2 git remotes', async () => {
    expect.assertions(1)
    mockGitRemotes.mockReturnValueOnce([
      { name: 'staging', url: 'https://git.heroku.com/myapp-staging.git' },
      { name: 'production', url: 'https://git.heroku.com/myapp-production.git' },
    ])
    try {
      await Command.mock()
    } catch (err) {
      expect(err.message).toContain('Multiple apps in git remotes')
    }
  })

  test('returns undefined with 2 git remotes when app not required', async () => {
    class Command extends Base {
      static flags = { app: flags.app({ required: false }), remote: flags.remote() }

      async run() {
        appfn(this.flags.app)
      }
    }

    mockGitRemotes.mockReturnValueOnce([
      { name: 'staging', url: 'https://git.heroku.com/myapp-staging.git' },
      { name: 'production', url: 'https://git.heroku.com/myapp-production.git' },
    ])
    await Command.mock()
    expect(appfn).toBeCalledWith(undefined)
  })

  test('gets app from git config', async () => {
    mockGitRemotes.mockReturnValueOnce([{ name: 'heroku', url: 'https://git.heroku.com/myapp.git' }])
    await Command.mock()
    expect(appfn).toBeCalledWith('myapp')
  })
})

describe('optional', () => {
  class Command extends Base {
    static flags = { app: flags.app(), remote: flags.remote() }

    async run() {
      appfn(this.flags.app)
    }
  }

  test('works when git errors out', async () => {
    expect.assertions(1)
    mockGitRemotes.mockImplementationOnce(() => {
      throw new Error('whoa!')
    })
    await Command.mock()
    expect(appfn).toBeCalledWith(undefined)
  })

  test('does not error when app is not specified', async () => {
    await Command.mock()
    expect(appfn).toBeCalledWith(undefined)
  })
})

describe('completion', () => {
  class Command extends Base {
    static flags = { app: flags.app({}) }
    async run() {}
  }

  test('cacheDuration defaults to 1 day', () => {
    const completion = Command.flags.app.completion!
    const duration = completion.cacheDuration
    expect(duration).toEqual(86400)
  })

  test('options returns all the apps', async () => {
    const completion = Command.flags.app.completion!
    api.get('/apps').reply(200, [{ id: 1, name: 'foo' }, { id: 2, name: 'bar' }])
    const options = await completion.options({ config })
    expect(options).toEqual(['bar', 'foo'])
  })
})
