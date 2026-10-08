import {CLIError} from '@oclif/core/errors'
import childProcess from 'node:child_process'

import {vars} from './vars.js'

export type IGitRemote = {
  name: string;
  url: string;
}

export class Git {
  get remotes(): IGitRemote[] {
    return this.exec('remote -v')
      .split('\n')
      .filter(l => l.endsWith('(fetch)'))
      .map(l => {
        const [name, url] = l.split('\t', 2)
        return {name, url: url.split(' ', 1)[0]}
      })
  }

  exec(cmd: string): string {
    try {
      return childProcess.execSync(`git ${cmd}`, {
        encoding: 'utf8',
        stdio: [null, 'pipe', null],
      })
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        throw new CLIError('Git must be installed to use the Heroku CLI.  See instructions here: http://git-scm.com')
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

export type IGitRemotes = {
  app: string;
  remote: string;
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
      if (match) {
        appRemotes.push({
          app: match[1],
          remote: remote.name,
        })
      }
    }
  }

  return appRemotes
}
