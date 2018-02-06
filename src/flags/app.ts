import {flags} from '@anycli/command'

import {herokuGet, oneDay} from '../completions'
import {Git} from '../git'
import {vars} from '../vars'

class MultipleRemotesError extends Error {
  constructor(gitRemotes: IGitRemote[]) {
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

export const AppCompletion: flags.ICompletion = {
  cacheDuration: oneDay,
  options: async ctx => {
    let apps = await herokuGet('apps', ctx)
    return apps
  },
}

export const app = flags.build({
  char: 'a',
  completion: AppCompletion,
  description: 'app to run command against',

  default: ({options, flags}) => {
    const envApp = process.env.HEROKU_APP
    if (envApp) return envApp
    let gitRemotes = getGitRemotes(flags.remote || configRemote())
    if (gitRemotes.length === 1) return gitRemotes[0].app
    if (flags.remote && gitRemotes.length === 0) {
      throw new Error(`remote ${flags.remote} not found in git remotes`)
    }
    if (gitRemotes.length > 1 && options.required) {
      throw new MultipleRemotesError(gitRemotes)
    }
  },
})

export const RemoteCompletion: flags.ICompletion = {
  skipCache: true,

  options: async () => {
    let remotes = getGitRemotes(configRemote())
    return remotes.map(r => r.remote)
  },
}

export const remote = flags.build({
  char: 'r',
  completion: RemoteCompletion,
  description: 'git remote of app to use',
})

function configRemote() {
  let git = new Git()
  try {
    return git.exec('config heroku.remote').trim()
  } catch {}
}

interface IGitRemote {
  remote: string
  app: string
}
function getGitRemotes(onlyRemote: string | undefined): IGitRemote[] {
  let git = new Git()
  let appRemotes = []
  let remotes
  try {
    remotes = git.remotes
  } catch {
    return []
  }
  for (let remote of remotes) {
    if (onlyRemote && remote.name !== onlyRemote) continue
    for (let prefix of vars.gitPrefixes) {
      const suffix = '.git'
      let match = remote.url.match(`${prefix}(.*)${suffix}`)
      if (!match) continue
      appRemotes.push({
        app: match[1],
        remote: remote.name,
      })
    }
  }
  return appRemotes
}
