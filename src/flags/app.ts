import {Errors, Flags} from '@oclif/core'

import {IGitRemotes, configRemote, getGitRemotes} from '../git.js'

class MultipleRemotesError extends Errors.CLIError {
  constructor(gitRemotes: IGitRemotes[]) {
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

export const app = Flags.custom({
  char: 'a',
  async default({flags, options}) {
    const envApp = process.env.HEROKU_APP
    if (envApp) return envApp
    const gitRemotes = getGitRemotes(flags.remote || configRemote())
    if (gitRemotes.length === 1) return gitRemotes[0].app
    if (flags.remote && gitRemotes.length === 0) {
      Errors.error(`remote ${flags.remote} not found in git remotes`)
    }

    if (gitRemotes.length > 1 && options.required) {
      throw new MultipleRemotesError(gitRemotes)
    }
  },
  description: 'app to run command against',
})

export const remote = Flags.custom({
  char: 'r',
  description: 'git remote of app to use',
})
