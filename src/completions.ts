import {Errors, Interfaces} from '@oclif/core'
import {readFile, readdir} from 'node:fs/promises'
import * as path from 'node:path'

import {APIClient} from './api-client.js'
import {configRemote, getGitRemotes} from './git.js'

export const oneDay = 60 * 60 * 24

export const herokuGet = async (resource: string, ctx: {config: Interfaces.Config}): Promise<string[]> => {
  const heroku = new APIClient(ctx.config)
  let {body: resources} = await heroku.get<any>(`/${resource}`)
  if (typeof resources === 'string') resources = JSON.parse(resources)
  return resources.map((a: any) => a.name).sort()
}

export const AppCompletion = {
  cacheDuration: oneDay,
  async options(ctx: { config: Interfaces.Config }) {
    const apps = await herokuGet('apps', ctx)
    return apps
  },
}

export const AppAddonCompletion = {
  cacheDuration: oneDay,
  async cacheKey(ctx: { flags: { app: any } }) {
    return ctx.flags && ctx.flags.app ? `${ctx.flags.app}_addons` : ''
  },
  async options(ctx: { config: Interfaces.Config; flags?: any }) {
    const addons = ctx.flags && ctx.flags.app ? await herokuGet(`apps/${ctx.flags.app}/addons`, ctx) : []
    return addons
  },
}

export const AppDynoCompletion = {
  cacheDuration: oneDay,
  async cacheKey(ctx: { flags: { app: any } }) {
    return ctx.flags && ctx.flags.app ? `${ctx.flags.app}_dynos` : ''
  },
  async options(ctx: { config: Interfaces.Config; flags?: any }) {
    const dynos = ctx.flags && ctx.flags.app ? await herokuGet(`apps/${ctx.flags.app}/dynos`, ctx) : []
    return dynos
  },
}

export const BuildpackCompletion = {
  async options() {
    return [
      'heroku/ruby',
      'heroku/nodejs',
      'heroku/clojure',
      'heroku/python',
      'heroku/java',
      'heroku/gradle',
      'heroku/scala',
      'heroku/php',
      'heroku/go',
    ]
  },

  skipCache: true,
}

export const DynoSizeCompletion = {
  cacheDuration: oneDay * 90,
  async options(ctx: { config: Interfaces.Config }) {
    const sizes = await herokuGet('dyno-sizes', ctx)
    return sizes
  },
}

export const FileCompletion = {
  async options() {
    const files = await readdir(process.cwd())
    return files
  },

  skipCache: true,
}

export const PipelineCompletion = {
  cacheDuration: oneDay,
  async options(ctx: { config: Interfaces.Config }) {
    const pipelines = await herokuGet('pipelines', ctx)
    return pipelines
  },
}

export const ProcessTypeCompletion = {
  async options() {
    let types: string[] = []
    const procfile = path.join(process.cwd(), 'Procfile')
    try {
      const buff = await readFile(procfile)
      types = buff
        .toString()
        .split('\n')
        .map((s: string) => {
          if (!s) return false
          const m = s.match(/^([\w-]+)/)
          return m ? m[0] : false
        })
        // eslint-disable-next-line unicorn/prefer-native-coercion-functions
        .filter((t: boolean | string) => t) as string[]
    } catch (error) {
      if (error instanceof Errors.CLIError && error.code !== 'ENOENT') throw error
    }

    return types
  },

  skipCache: true,
}

export const RegionCompletion = {
  cacheDuration: oneDay * 7,
  async options(ctx: { config: Interfaces.Config }) {
    const regions = await herokuGet('regions', ctx)
    return regions
  },
}

export const RemoteCompletion = {
  async options() {
    const remotes = getGitRemotes(configRemote())
    return remotes.map(r => r.remote)
  },

  skipCache: true,
}

export const RoleCompletion = {
  async options() {
    return ['admin', 'collaborator', 'member', 'owner']
  },

  skipCache: true,
}

export const ScopeCompletion = {
  async options() {
    return ['global', 'identity', 'read', 'write', 'read-protected', 'write-protected']
  },

  skipCache: true,
}

export const SpaceCompletion = {
  cacheDuration: oneDay,
  async options(ctx: { config: Interfaces.Config }) {
    const spaces = await herokuGet('spaces', ctx)
    return spaces
  },
}

export const StackCompletion = {
  cacheDuration: oneDay,
  async options(ctx: { config: Interfaces.Config }) {
    const stacks = await herokuGet('stacks', ctx)
    return stacks
  },
}

export const StageCompletion = {
  async options() {
    return ['test', 'review', 'development', 'staging', 'production']
  },

  skipCache: true,
}

export const TeamCompletion = {
  cacheDuration: oneDay,
  async options(ctx: { config: Interfaces.Config }) {
    const teams = await herokuGet('teams', ctx)
    return teams
  },
}
