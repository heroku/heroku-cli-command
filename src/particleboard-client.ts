import {Interfaces} from '@oclif/core'
import {HTTP, HTTPRequestOptions} from '@heroku/http-call'
import * as url from 'url'

import deps from './deps'
import {RequestId, requestIdHeader} from './request-id'
import {vars} from './vars'

export interface IDelinquencyInfo {
  scheduled_suspension_time?: string | null
  scheduled_deletion_time?: string | null
}

export interface IDelinquencyConfig {
  fetch_delinquency: boolean
  warning_shown: boolean
  resource_type?: 'account' | 'team'
  fetch_url?: string
}

export class ParticleboardClient {
  http: typeof HTTP
  private _auth?: string

  constructor(protected config: Interfaces.Config) {
    this.config = config
    const particleboardUrl = url.URL ? new url.URL(vars.particleboardUrl) : url.parse(vars.particleboardUrl)
    const self = this as any
    const envParticleboardHeaders = JSON.parse(process.env.HEROKU_PARTICLEBOARD_HEADERS || '{}')
    const particleboardOpts = {
      host: particleboardUrl.hostname,
      port: particleboardUrl.port,
      protocol: particleboardUrl.protocol,
      headers: {
        accept: 'application/vnd.heroku+json; version=3',
        'user-agent': `heroku-cli/${self.config.version} ${self.config.platform}`,
        ...envParticleboardHeaders,
      },
    }
    this.http = class ParticleboardHTTPClient<T> extends deps.HTTP.HTTP.create(particleboardOpts)<T> {
      static trackRequestIds<T>(response: HTTP<T>) {
        const responseRequestIdHeader = response.headers[requestIdHeader] || response.headers[requestIdHeader.toLocaleLowerCase()]

        if (responseRequestIdHeader) {
          const requestIds = Array.isArray(responseRequestIdHeader) ? responseRequestIdHeader : responseRequestIdHeader.split(',')
          RequestId.track(...requestIds)
        }
      }

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
    }
  }

  get auth(): string | undefined {
    return this._auth
  }

  set auth(token: string | undefined) {
    this._auth = token
  }

  get<T>(url: string, options: HTTPRequestOptions = {}) {
    return this.http.get<T>(url, options)
  }

  get defaults(): typeof HTTP.defaults {
    return this.http.defaults
  }
}
