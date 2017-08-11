// @flow

import Base from '../command'
import {app, remote} from './app'
import nock from 'nock'
import Output from 'cli-engine-command/lib/output'

let mockGitRemotes = jest.fn()

jest.mock('../git', () => {
  return class {
    get remotes () { return mockGitRemotes() }
  }
})

beforeEach(() => {
  mockGitRemotes.mockReturnValue([])
})

describe('required', () => {
  class Command extends Base {
    static flags = {app: app({required: true}), remote: remote()}
  }

  test('has an app', async () => {
    const cmd = await Command.mock('--app', 'myapp')
    expect(cmd.flags.app).toEqual('myapp')
  })

  test('gets app from --remote flag', async () => {
    mockGitRemotes.mockReturnValueOnce([
      {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
      {name: 'production', url: 'https://git.heroku.com/myapp-production.git'}
    ])
    const cmd = await Command.mock('-r', 'staging')
    expect(cmd.flags.app).toEqual('myapp-staging')
  })

  test('errors if --remote not found', async () => {
    expect.assertions(1)
    mockGitRemotes.mockReturnValueOnce([
      {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
      {name: 'production', url: 'https://git.heroku.com/myapp-production.git'}
    ])
    try {
      let cmd = await Command.mock('-r', 'foo')
      cmd.out.log(cmd.flags.app)
    } catch (err) {
      expect(err.message).toEqual('remote foo not found in git remotes')
    }
  })

  test('errors with no app', async () => {
    expect.assertions(1)
    try {
      let cmd = await Command.mock()
      console.log(cmd.flags.app) // should not get here
    } catch (err) {
      expect(err.message).toContain('No app specified')
    }
  })

  test('errors with 2 git remotes', async () => {
    expect.assertions(1)
    mockGitRemotes.mockReturnValueOnce([
      {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
      {name: 'production', url: 'https://git.heroku.com/myapp-production.git'}
    ])
    try {
      let cmd = await Command.mock()
      console.log(cmd.flags.app) // should not get here
    } catch (err) {
      expect(err.message).toContain('Multiple apps in git remotes')
    }
  })

  test('returns undefined with 2 git remotes when app not required', async () => {
    class Command extends Base {
      static flags = {app: app({required: false}), remote: remote()}
    }

    mockGitRemotes.mockReturnValueOnce([
      {name: 'staging', url: 'https://git.heroku.com/myapp-staging.git'},
      {name: 'production', url: 'https://git.heroku.com/myapp-production.git'}
    ])
    const cmd = await Command.mock()
    expect(cmd.flags.app).toEqual(undefined)
  })

  test('gets app from git config', async () => {
    mockGitRemotes.mockReturnValueOnce([{name: 'heroku', url: 'https://git.heroku.com/myapp.git'}])
    const cmd = await Command.mock()
    expect(cmd.flags.app).toEqual('myapp')
  })
})

describe('optional', () => {
  class Command extends Base {
    static flags = {app: app(), remote: remote()}
  }

  test('works when git errors out', async () => {
    expect.assertions(1)
    mockGitRemotes.mockImplementationOnce(() => {
      throw new Error('whoa!')
    })
    const cmd = await Command.mock()
    expect(cmd.flags.app).toBeUndefined()
  })

  test('does not error when app is not specified', async () => {
    const cmd = await Command.mock()
    expect(cmd.flags.app).toBeUndefined()
  })
})

describe('completion', () => {
  class Command extends Base {
    static flags = {app: app({})}
  }

  let completion
  beforeAll(() => {
    completion = Command.flags.app.completion || {}
  })

  let api
  beforeEach(() => {
    api = nock('https://api.heroku.com')
  })
  afterEach(() => {
    api.done()
  })

  test('cacheDuration defaults to 1 day', () => {
    const duration = completion.cacheDuration
    expect(duration).toEqual(86400)
  })

  test('options returns all the apps', async () => {
    api.get('/apps').reply(200, [{id: 1, name: 'foo'}, {id: 2, name: 'bar'}])
    const out = new Output()
    const options = await completion.options({out: out})
    expect(options).toEqual(['bar', 'foo'])
  })
})
