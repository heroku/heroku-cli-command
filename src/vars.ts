import {ux} from '@oclif/core/ux'

const ALLOWED_HEROKU_DOMAINS = Object.freeze(['heroku.com', 'herokai.com', 'herokuspace.com', 'herokudev.com'])

function safeHostForDiagnostic(host: string): string {
  try {
    const parsed = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`)
    if (parsed.username || parsed.password) {
      const authority = parsed.host
      return `${parsed.protocol}//[REDACTED]@${authority}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`
    }

    return /^https?:\/\//i.test(host) ? parsed.href.replace(/\/$/, '') : parsed.host
  } catch {
    return host.replace(/(https?:\/\/)[^/?#@]*@/i, '$1[REDACTED]@')
  }
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true
  const octets = normalized.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

export interface ResolvedVars {
  apiHost: string
  apiUrl: string
  gitHost: string
  gitPrefixes: string[]
  host: string
  httpGitHost: string
}

export class Vars {
  private cachedConfig?: ResolvedVars
  private cachedEnv?: NodeJS.ProcessEnv
  private cachedEnvGitHost?: string
  private cachedEnvHost?: string
  private readonly warnedInvalidHosts = new Set<string>()

  get apiHost(): string {
    return this.resolve().apiHost
  }

  get apiUrl(): string {
    return this.resolve().apiUrl
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
    return this.resolve().gitHost
  }

  get gitPrefixes(): string[] {
    return this.resolve().gitPrefixes
  }

  get host(): string {
    return this.resolve().host
  }

  get httpGitHost(): string {
    return this.resolve().httpGitHost
  }

  // This should be fixed after we make our staging hostnames consistent throughout all services
  // changing the staging cloud URL to `particleboard.staging.herokudev.com`.
  get particleboardUrl(): string {
    if (this.envParticleboardUrl) return this.envParticleboardUrl
    return process.env.HEROKU_CLOUD === 'staging'
      ? 'https://particleboard-staging-cloud.herokuapp.com'
      : 'https://particleboard.heroku.com'
  }

  resolve(): ResolvedVars {
    const {envGitHost, envHost} = this
    if (this.cachedConfig && process.env === this.cachedEnv && envHost === this.cachedEnvHost && envGitHost === this.cachedEnvGitHost) {
      return this.cachedConfig
    }

    let host = envHost || 'heroku.com'
    if (envHost && !this.isValidHerokuHost(envHost)) {
      if (!this.warnedInvalidHosts.has(envHost)) {
        this.warnedInvalidHosts.add(envHost)
        ux.warn(`Invalid HEROKU_HOST '${safeHostForDiagnostic(envHost)}' - using default`)
      }

      host = 'heroku.com'
    }

    const parsedHost = /^https?:\/\//i.test(host) ? new URL(host).host : undefined
    const bareHostname = parsedHost ? undefined : new URL(`https://${host}`).hostname
    const bareLoopback = Boolean(bareHostname && isLoopback(bareHostname))
    const apiHost = parsedHost || (bareLoopback ? host : `api.${host}`)
    const apiUrl = parsedHost ? host : `${bareLoopback ? 'http' : 'https'}://${apiHost}`
    const gitHost = envGitHost || parsedHost || host
    const httpGitHost = envGitHost || parsedHost || (bareLoopback ? host : `git.${host}`)

    this.cachedEnv = process.env
    this.cachedEnvGitHost = envGitHost
    this.cachedEnvHost = envHost
    this.cachedConfig = {
      apiHost,
      apiUrl,
      gitHost,
      gitPrefixes: [`git@${gitHost}:`, `ssh://git@${gitHost}/`, `https://${httpGitHost}/`],
      host,
      httpGitHost,
    }
    return this.cachedConfig
  }

  private isValidHerokuHost(host: string): boolean {
    try {
      const isUrl = /^https?:\/\//i.test(host)
      const parsed = new URL(isUrl ? host : `https://${host}`)
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false
      if (isUrl && (host.includes('?') || host.includes('#'))) return false

      const hostname = parsed.hostname.toLowerCase()
      const loopback = isLoopback(hostname)
      if (isUrl && parsed.protocol === 'http:' && !loopback) return false
      return ALLOWED_HEROKU_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`)) || loopback
    } catch {
      return false
    }
  }
}

export const vars = new Vars()
