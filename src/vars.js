// @flow

import url from 'url'

export class Vars {
  env: typeof process.env
  constructor (env: typeof process.env) {
    this.env = env
  }

  get host (): string { return this.env.HEROKU_HOST || 'heroku.com' }
  get apiUrl (): string { return this.host.startsWith('http') ? this.host : `https://api.${this.host}` }
  get apiHost (): string {
    if (this.host.startsWith('http')) {
      const u = url.parse(this.host)
      if (u.host) return u.host
    }
    return `api.${this.host}`
  }
  get gitHost (): string {
    if (this.env.HEROKU_GIT_HOST) return this.env.HEROKU_GIT_HOST
    if (this.host.startsWith('http')) {
      const u = url.parse(this.host)
      if (u.host) return u.host
    }
    return this.host
  }
  get httpGitHost (): string {
    if (this.env.HEROKU_GIT_HOST) return this.env.HEROKU_GIT_HOST
    if (this.host.startsWith('http')) {
      const u = url.parse(this.host)
      if (u.host) return u.host
    }
    return `git.${this.host}`
  }

  get gitPrefixes (): string[] {
    return [
      `git@${this.gitHost}:`,
      `ssh://git@${this.gitHost}/`,
      `https://${this.httpGitHost}/`
    ]
  }
}

export default new Vars(process.env)
