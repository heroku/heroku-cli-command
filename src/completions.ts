import {Interfaces, Errors} from '@oclif/core'
import * as path from 'node:path'
import deps from './deps'
import {configRemote, getGitRemotes} from './git'

export const oneDay = 60 * 60 * 24

export const herokuGet = async (resource: string, ctx: {config: Interfaces.Config}): Promise<string[]> => {
  const heroku = new deps.APIClient(ctx.config)
  let {body: resources} = await heroku.get<any>(`/${resource}`)
  if (typeof resources === 'string') resources = JSON.parse(resources)
  return resources.map((a: any) => a.name).sort()
}

export const AppCompletion = {
  cacheDuration: oneDay,
  options: async (ctx: { config: Interfaces.Config }) => {
    const apps = await herokuGet('apps', ctx)
    return apps
  },
}

export const AppAddonCompletion = {
  cacheDuration: oneDay,
  cacheKey: async (ctx: { flags: { app: any } }) => {
    return ctx.flags && ctx.flags.app ? `${ctx.flags.app}_addons` : ''
  },
  options: async (ctx: { flags?: any; config: Interfaces.Config }) => {
    const addons = ctx.flags && ctx.flags.app ? await herokuGet(`apps/${ctx.flags.app}/addons`, ctx) : []
    return addons
  },
}

export const AppDynoCompletion = {
  cacheDuration: oneDay,
  cacheKey: async (ctx: { flags: { app: any } }) => {
    return ctx.flags && ctx.flags.app ? `${ctx.flags.app}_dynos` : ''
  },
  options: async (ctx: { flags?: any; config: Interfaces.Config }) => {
    const dynos = ctx.flags && ctx.flags.app ? await herokuGet(`apps/${ctx.flags.app}/dynos`, ctx) : []
    return dynos
  },
}

export const BuildpackCompletion = {
  skipCache: true,

  options: async () => {
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
}

export const DynoSizeCompletion = {
  cacheDuration: oneDay * 90,
  options: async (ctx: { config: Interfaces.Config }) => {
    const sizes = await herokuGet('dyno-sizes', ctx)
    return sizes
  },
}

export const FileCompletion = {
  skipCache: true,

  options: async () => {
    const files = await deps.file.readdir(process.cwd())
    return files
  },
}

export const PipelineCompletion = {
  cacheDuration: oneDay,
  options: async (ctx: { config: Interfaces.Config }) => {
    const pipelines = await herokuGet('pipelines', ctx)
    return pipelines
  },
}

export const ProcessTypeCompletion = {
  skipCache: true,

  options: async () => {
    let types: string[] = []
    const procfile = path.join(process.cwd(), 'Procfile')
    try {
      const buff = await deps.file.readFile(procfile)
      types = buff
        .toString()
        .split('\n')
        .map((s: string) => {
          if (!s) return false
          const m = s.match(/^([\w-]+)/)
          return m ? m[0] : false
        })
        .filter((t: string | boolean) => t) as string[]
    } catch (error) {
      if (error instanceof Errors.CLIError && error.code !== 'ENOENT') throw error
    }

    return types
  },
}

export const RegionCompletion = {
  cacheDuration: oneDay * 7,
  options: async (ctx: { config: Interfaces.Config }) => {
    const regions = await herokuGet('regions', ctx)
    return regions
  },
}

export const RemoteCompletion = {
  skipCache: true,

  options: async () => {
    const remotes = getGitRemotes(configRemote())
    return remotes.map(r => r.remote)
  },
}

export const RoleCompletion = {
  skipCache: true,

  options: async () => {
    return ['admin', 'collaborator', 'member', 'owner']
  },
}

export const ScopeCompletion = {
  skipCache: true,

  options: async () => {
    return ['global', 'identity', 'read', 'write', 'read-protected', 'write-protected']
  },
}

export const SpaceCompletion = {
  cacheDuration: oneDay,
  options: async (ctx: { config: Interfaces.Config }) => {
    const spaces = await herokuGet('spaces', ctx)
    return spaces
  },
}

export const StackCompletion = {
  cacheDuration: oneDay,
  options: async (ctx: { config: Interfaces.Config }) => {
    const stacks = await herokuGet('stacks', ctx)
    return stacks
  },
}

export const StageCompletion = {
  skipCache: true,

  options: async () => {
    return ['test', 'review', 'development', 'staging', 'production']
  },
}

export const TeamCompletion = {
  cacheDuration: oneDay,
  options: async (ctx: { config: Interfaces.Config }) => {
    const teams = await herokuGet('teams', ctx)
    return teams
  },
}
