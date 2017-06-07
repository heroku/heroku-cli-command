// @flow

import http from 'cli-engine-command/lib/http'
import type Output from 'cli-engine-command/lib/output'
import type HTTPError from 'http-call'

type Options = {
  required?: boolean
}

type HerokuAPIErrorOptions = $Shape<{
  resource: ?string,
  app: ?{id: ?string, name: ?string},
  id: ?string,
  message: ?string,
  url: ?string
}>

export class HerokuAPIError extends Error {
  httpError: HTTPError

  constructor (httpError: HTTPError) {
    let options: HerokuAPIErrorOptions = httpError.body
    if (!options.message) throw httpError
    let info = []
    if (options.id) info.push(`Error ID: ${options.id}`)
    if (options.app && options.app.name) info.push(`App: ${options.app.name}`)
    if (options.url) info.push(`See ${options.url} for more information.`)
    if (info.length) super([options.message, ''].concat(info).join('\n'))
    else super(options.message)
    this.httpError = httpError
  }
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
    let self = this
    this.http = class extends this.http {
      async request () {
        self._logRequest(this)
        try {
          await super.request()
        } catch (err) {
          if (err.__httpcall) throw new HerokuAPIError(err)
          else throw err
        }
        self._logResponse(this)
      }
    }
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
