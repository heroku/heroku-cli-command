import {Errors} from '@oclif/core'

import {vars} from './vars'

export interface IGitRemote {
  name: string
  url: string
}

export class Git {
  get remotes(): IGitRemote[] {
    return this.exec('remote -v')
      .split('\n')
      .filter(l => l.endsWith('(fetch)'))
      .map(l => {
        const [name, url] = l.split('\t')
        return {name, url: url.split(' ')[0]}
      })
  }

  exec(cmd: string): string {
    const {execSync: exec} = require('child_process')
    try {
      return exec(`git ${cmd}`, {
        encoding: 'utf8',
        stdio: [null, 'pipe', null],
      })
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        throw new Errors.CLIError('Git must be installed to use the Heroku CLI.  See instructions here: http://git-scm.com')
      }

      throw error
    }
  }
}

export function configRemote() {
  const git = new Git()
  try {
    return git.exec('config heroku.remote').trim()
  } catch {}
}

export interface IGitRemotes {
  app: string
  remote: string
}

export function getGitRemotes(onlyRemote: string | undefined): IGitRemotes[] {
  const git = new Git()
  const appRemotes = []
  let remotes
  try {
    remotes = git.remotes
  } catch {
    return []
  }

  for (const remote of remotes) {
    if (onlyRemote && remote.name !== onlyRemote) continue
    for (const prefix of vars.gitPrefixes) {
      const suffix = '.git'
      const match = remote.url.match(`${prefix}(.*)${suffix}`)
      if (!match) continue
      appRemotes.push({
        app: match[1],
        remote: remote.name,
      })
    }
  }

  return appRemotes
}
