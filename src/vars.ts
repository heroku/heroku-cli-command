import * as url from 'node:url'

export class Vars {
  get apiHost(): string {
    if (this.host.startsWith('http')) {
      const u = url.parse(this.host)
      if (u.host) return u.host
    }

    return `api.${this.host}`
  }

  get apiUrl(): string {
    return this.host.startsWith('http') ? this.host : `https://api.${this.host}`
  }

  get envGitHost(): string | undefined {
    return process.env.HEROKU_GIT_HOST
  }

  get envHost(): string | undefined {
    return process.env.HEROKU_HOST
  }

  get envParticleboardUrl(): string | undefined {
    return process.env.HEROKU_PARTICLEBOARD_URL
  }

  get gitHost(): string {
    if (this.envGitHost) return this.envGitHost
    if (this.host.startsWith('http')) {
      const u = url.parse(this.host)
      if (u.host) return u.host
    }

    return this.host
  }

  get gitPrefixes(): string[] {
    return [`git@${this.gitHost}:`, `ssh://git@${this.gitHost}/`, `https://${this.httpGitHost}/`]
  }

  get host(): string {
    return this.envHost || 'heroku.com'
  }

  get httpGitHost(): string {
    if (this.envGitHost) return this.envGitHost
    if (this.host.startsWith('http')) {
      const u = url.parse(this.host)
      if (u.host) return u.host
    }

    return `git.${this.host}`
  }

  // This should be fixed after we make our staging hostnames consistent throughout all services
  // changing the staging cloud URL to `particleboard.staging.herokudev.com`.
  get particleboardUrl(): string {
    if (this.envParticleboardUrl) return this.envParticleboardUrl
    return process.env.HEROKU_CLOUD === 'staging'
      ? 'https://particleboard-staging-cloud.herokuapp.com'
      : 'https://particleboard.heroku.com'
  }
}

export const vars = new Vars()
