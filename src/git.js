// @flow

export type Remote = {
  name: string,
  url: string
}

export default class Git {
  get remotes (): Remote[] {
    return this.exec('remote -v').split('\n')
      .filter(l => l.endsWith('(fetch)'))
      .map(l => {
        const [name, url] = l.split('\t')
        return {name, url: url.split(' ')[0]}
      })
  }

  exec (cmd: string): string {
    const {execSync: exec} = require('child_process')
    try {
      return exec(`git ${cmd}`, {encoding: 'utf8', stdio: [null, 'pipe', null]})
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('Git must be installed to use the Heroku CLI.  See instructions here: http://git-scm.com')
      }
      throw error
    }
  }
}
