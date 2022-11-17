import * as url from 'url'

export class Vars {
  get host(): string {
    return this.envHost || 'heroku.com'
  }

  get apiUrl(): string {
    return this.host.startsWith('http') ? this.host : `https://api.${this.host}`
  }

  get apiHost(): string {
    if (this.host.startsWith('http')) {
      const u = url.parse(this.host)
      if (u.host) return u.host
    }

    return `api.${this.host}`
  }

  get envHost(): string | undefined {
    return process.env.HEROKU_HOST
  }

  get envGitHost(): string | undefined {
    return process.env.HEROKU_GIT_HOST
  }

  get gitHost(): string {
    if (this.envGitHost) return this.envGitHost
    if (this.host.startsWith('http')) {
      const u = url.parse(this.host)
      if (u.host) return u.host
    }

    return this.host
  }

  get httpGitHost(): string {
    if (this.envGitHost) return this.envGitHost
    if (this.host.startsWith('http')) {
      const u = url.parse(this.host)
      if (u.host) return u.host
    }

    return `git.${this.host}`
  }

  get gitPrefixes(): string[] {
    return [`git@${this.gitHost}:`, `ssh://git@${this.gitHost}/`, `https://${this.httpGitHost}/`]
  }
}

export const vars = new Vars()
