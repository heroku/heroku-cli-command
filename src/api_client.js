// @flow

import http from 'cli-engine-command/lib/http'
import url from 'url'
import type Output from 'cli-engine-command/lib/output'

type Options = {
  required?: boolean
}

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

export const vars = new Vars(process.env)

export default class Heroku extends http {
  options: Options
  constructor (output: Output, options: Options = {}) {
    super(output)
    if (options.required === undefined) options.required = true
    this.options = options
    this.requestOptions.host = 'api.heroku.com'
    this.requestOptions.protocol = 'https:'
    if (this.auth) this.requestOptions.headers['authorization'] = `:${this.auth}`
    this.requestOptions.headers['user-agent'] = `heroku-cli/${this.out.config.version}`
    this.requestOptions.headers['accept'] = 'application/vnd.heroku+json; version=3'
  }

  get auth (): ?string {
    let auth = process.env.HEROKU_API_KEY
    if (!auth) {
      const Netrc = require('netrc-parser')
      const netrc = new Netrc()
      auth = netrc.machines[vars.apiHost].password
    }
    // TODO: handle required
    return auth
  }
}
