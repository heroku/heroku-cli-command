import {Flags} from '@oclif/core'
import {CLIError, error} from '@oclif/core/lib/errors'
import {CompletableOptionFlag} from '@oclif/core/lib/interfaces/parser'

import {AppCompletion, RemoteCompletion} from '../completions'
import {configRemote, getGitRemotes, IGitRemotes} from '../git'

class MultipleRemotesError extends CLIError {
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

const appWithoutCompletion = Flags.custom({
  char: 'a',
  description: 'app to run command against',
  default: async ({options, flags}) => {
    const envApp = process.env.HEROKU_APP
    if (envApp) return envApp
    const gitRemotes = getGitRemotes(flags.remote || configRemote())
    if (gitRemotes.length === 1) return gitRemotes[0].app
    if (flags.remote && gitRemotes.length === 0) {
      error(`remote ${flags.remote} not found in git remotes`)
    }
    if (gitRemotes.length > 1 && options.required) {
      throw new MultipleRemotesError(gitRemotes)
    }
  },
})

// this approach is used to avoid a breaking change and TS overrides. `completion` will not show as available in the
// interface, but it didn't in the past.
export const app = (flagArgs: Partial<CompletableOptionFlag<string>> = {}) => appWithoutCompletion({...flagArgs, completion: AppCompletion})

const remoteWithoutCompletion = Flags.custom({
  char: 'r',
  description: 'git remote of app to use',
})

export const remote = (flagArgs: Partial<CompletableOptionFlag<string>> = {}) => remoteWithoutCompletion({...flagArgs, completion: RemoteCompletion})
