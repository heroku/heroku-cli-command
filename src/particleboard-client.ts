import {HTTP, HTTPRequestOptions} from '@heroku/http-call'
import {Interfaces} from '@oclif/core'
import * as url from 'node:url'

import {RequestId, requestIdHeader} from './request-id.js'
import {vars} from './vars.js'

export interface IDelinquencyInfo {
  scheduled_deletion_time?: null | string
  scheduled_suspension_time?: null | string
}

export interface IDelinquencyConfig {
  fetch_delinquency: boolean
  fetch_url?: string
  resource_type?: 'account' | 'team'
  warning_shown: boolean
}

export class ParticleboardClient {
  http: typeof HTTP
  private _auth?: string

  constructor(protected config: Interfaces.Config) {
    this.config = config
    const particleboardUrl = new url.URL(vars.particleboardUrl)
    const self = this as any
    const envParticleboardHeaders = JSON.parse(process.env.HEROKU_PARTICLEBOARD_HEADERS || '{}')
    const particleboardOpts = {
      headers: {
        accept: 'application/vnd.heroku+json; version=3',
        'user-agent': `heroku-cli/${self.config.version} ${self.config.platform}`,
        ...envParticleboardHeaders,
      },
      host: particleboardUrl.hostname,
      port: particleboardUrl.port,
      protocol: particleboardUrl.protocol,
    }
    this.http = class ParticleboardHTTPClient<T> extends HTTP.create(particleboardOpts)<T> {
      static async request<T>(url: string, opts: HTTPRequestOptions = {}): Promise<ParticleboardHTTPClient<T>> {
        opts.headers = opts.headers || {}
        opts.headers[requestIdHeader] = RequestId.create() && RequestId.headerValue

        if (!Object.keys(opts.headers).some(h => h.toLowerCase() === 'authorization')) {
          opts.headers.authorization = `Bearer ${self.auth}`
        }

        const response = await super.request<T>(url, opts)
        this.trackRequestIds<T>(response)
        return response
      }

      static trackRequestIds<T>(response: HTTP<T>) {
        const responseRequestIdHeader = response.headers[requestIdHeader] || response.headers[requestIdHeader.toLocaleLowerCase()]

        if (responseRequestIdHeader) {
          const requestIds = Array.isArray(responseRequestIdHeader) ? responseRequestIdHeader : responseRequestIdHeader.split(',')
          RequestId.track(...requestIds)
        }
      }
    }
  }

  get auth(): string | undefined {
    return this._auth
  }

  set auth(token: string | undefined) {
    this._auth = token
  }

  get defaults(): typeof HTTP.defaults {
    return this.http.defaults
  }

  get<T>(url: string, options: HTTPRequestOptions = {}) {
    return this.http.get<T>(url, options)
  }
}
