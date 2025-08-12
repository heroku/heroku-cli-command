import {ux} from '@oclif/core'
import * as url from 'node:url'

import {ALLOWED_HEROKU_DOMAINS, LOCALHOST_DOMAINS} from './api-client.js'

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
    const {envHost} = this

    if (envHost && !this.isValidHerokuHost(envHost)) {
      ux.warn(`Invalid HEROKU_HOST '${envHost}' - using default`)
      return 'heroku.com'
    }

    return envHost || 'heroku.com'
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

  private isValidHerokuHost(host: string): boolean {
    // Remove protocol if present
    const cleanHost = host.replace(/^https?:\/\//, '')

    return ALLOWED_HEROKU_DOMAINS.some(domain => cleanHost.endsWith(`.${domain}`)) || LOCALHOST_DOMAINS.some(domain => cleanHost.includes(domain))
  }
}

export const vars = new Vars()
