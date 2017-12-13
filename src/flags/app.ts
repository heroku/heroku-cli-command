import { vars } from '../vars'
import { flags, FlagBuilder } from 'cli-engine-command'
import { Git } from '../git'
import { AppCompletion, RemoteCompletion } from '../completions'

class MultipleRemotesError extends Error {
  constructor(gitRemotes: GitRemote[]) {
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

export const app: FlagBuilder<string> = flags.option<string>({
  description: 'app to run command against',
  char: 'a',
  default: ({ options, flags }) => {
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
  completion: AppCompletion,
})

export const remote: FlagBuilder = flags.option({
  char: 'r',
  description: 'git remote of app to use',
  completion: RemoteCompletion,
})

export function configRemote() {
  let git = new Git()
  try {
    return git.exec('config heroku.remote').trim()
  } catch (err) {}
}

export type GitRemote = { remote: string; app: string }
export function getGitRemotes(onlyRemote: string | undefined): GitRemote[] {
  let git = new Git()
  let appRemotes = []
  let remotes
  try {
    remotes = git.remotes
  } catch (err) {
    return []
  }
  for (let remote of remotes) {
    if (onlyRemote && remote.name !== onlyRemote) continue
    for (let prefix of vars.gitPrefixes) {
      const suffix = '.git'
      let match = remote.url.match(`${prefix}(.*)${suffix}`)
      if (!match) continue
      appRemotes.push({
        remote: remote.name,
        app: match[1],
      })
    }
  }
  return appRemotes
}
