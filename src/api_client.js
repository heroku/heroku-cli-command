// @flow

import http from 'cli-engine-command/lib/http'
import type Output from 'cli-engine-command/lib/output'

type Options = {
  required?: boolean
}

export default class Heroku extends http {
  options: Options
  constructor (output: Output, options: Options = {}) {
    super(output)
    if (options.required === undefined) options.required = true
    this.options = options
    this.requestOptions.host = 'api.heroku.com'
    this.requestOptions.protocol = 'https:'
    if (this.auth) this.requestOptions.headers['authorization'] = `Bearer ${this.auth}`
    this.requestOptions.headers['user-agent'] = `heroku-cli/${this.out.config.version}`
    this.requestOptions.headers['accept'] = 'application/vnd.heroku+json; version=3'
  }

  get auth (): ?string {
    let auth = process.env.HEROKU_API_KEY
    if (!auth) {
      const Netrc = require('netrc-parser')
      const netrc = new Netrc()
      auth = netrc.machines[require('./vars').default.apiHost].password
    }
    // TODO: handle required
    return auth
  }
}
