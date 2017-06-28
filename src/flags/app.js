// @flow

import vars from '../vars'
import type {Flag} from 'cli-engine-command/lib/flags'
import type Output from 'cli-engine-command/lib/output'
import {merge} from '.'
import Git from '../git'
import Heroku from '../api_client'

class MultipleRemotesError extends Error {
  constructor (gitRemotes) {
    super(`Multiple apps in git remotes
  Usage: --remote ${gitRemotes[1].remote}
     or: --app ${gitRemotes[1].app}
  Your local git repository has more than 1 app referenced in git remotes.
  Because of this, we can't determine which app you want to run this command against.
  Specify the app you want with --app or --remote.
  Heroku remotes in repo:
  ${gitRemotes.map(r => `${r.app} (${r.remote})`).join('\n')}

  https://devcenter.heroku.com/articles/multiple-environments`)
  }
}

type Options = $Shape<Flag<string>>
export function app (options: Options = {}, env: typeof process.env = process.env): Flag<string> {
  const envApp = env.HEROKU_APP
  const defaultOptions: Options = {
    char: 'a',
    description: 'app to run command against',
    default: () => envApp,
    parse: (input, cmd) => {
      if (cmd && cmd.flags.app) return cmd.flags.app
      if (input) return input
      if (envApp) return envApp
      if (cmd) {
        let gitRemotes = getGitRemotes(cmd.flags.remote || configRemote())
        if (gitRemotes.length === 1) return gitRemotes[0].app
        if (cmd.flags.remote && gitRemotes.length === 0) {
          throw new Error(`remote ${cmd.flags.remote} not found in git remotes`)
        }
        if (gitRemotes.length > 1 && options.required) {
          throw new MultipleRemotesError(gitRemotes)
        }
      }
      if (options.required) throw new Error('No app specified')
    },
    completion: {
      cacheDuration: 60 * 60 * 24, // 1 day
      options: async (out: Output) => {
        const heroku = new Heroku({out: out})
        let apps = await heroku.get('/apps')
        return apps.map(a => a.name).sort()
      }
    }
  }
  return merge(defaultOptions, options)
}

export function remote (options: Options = {}): Flag<string> {
  const defaultOptions: Options = {
    char: 'r',
    description: 'git remote of app to use',
    parse: input => input
  }
  return merge(defaultOptions, options)
}

function configRemote () {
  let git = new Git()
  try {
    return git.exec('config heroku.remote').trim()
  } catch (err) { }
}

function getGitRemotes (onlyRemote: ?string): {remote: string, app: string}[] {
  let git = new Git()
  let appRemotes = []
  let remotes = []
  try {
    remotes = git.remotes
  } catch (err) { }
  for (let remote of remotes) {
    if (onlyRemote && remote.name !== onlyRemote) continue
    for (let prefix of vars.gitPrefixes) {
      const suffix = '.git'
      let match = remote.url.match(`${prefix}(.*)${suffix}`)
      if (!match) continue
      appRemotes.push({
        remote: remote.name,
        app: match[1]
      })
    }
  }
  return appRemotes
}
