import {Flags, Config } from '@oclif/core'
import { Completion, CompletionContext } from '@oclif/core/lib/interfaces'
import * as path from 'path'

import deps from './deps'
import {configRemote, getGitRemotes} from './git'

export const oneDay = 60 * 60 * 24

export const herokuGet = async (resource: string, cfg: { config: Config }): Promise<string[]> => {
  const heroku = new deps.APIClient(cfg.config)
  let {body: resources} = await heroku.get<any>(`/${resource}`)
  if (typeof resources === 'string') resources = JSON.parse(resources)
  return resources.map((a: any) => a.name).sort()
}

export const AppCompletion: Completion = {
  cacheDuration: oneDay,
  options: async ctx => {
    const apps = await herokuGet('apps', ctx)
    return apps
  },
}

export const AppAddonCompletion: Completion = {
  cacheDuration: oneDay,
  cacheKey: async ctx => {
    return ctx.flags && ctx.flags.app ? `${ctx.flags.app}_addons` : ''
  },
  options: async ctx => {
    const addons = ctx.flags && ctx.flags.app ? await herokuGet(`apps/${ctx.flags.app}/addons`, ctx) : []
    return addons
  },
}

export const AppDynoCompletion: Completion = {
  cacheDuration: oneDay,
  cacheKey: async ctx => {
    return ctx.flags && ctx.flags.app ? `${ctx.flags.app}_dynos` : ''
  },
  options: async ctx => {
    const dynos = ctx.flags && ctx.flags.app ? await herokuGet(`apps/${ctx.flags.app}/dynos`, ctx) : []
    return dynos
  },
}

export const BuildpackCompletion: Completion = {
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

export const DynoSizeCompletion: Completion = {
  cacheDuration: oneDay * 90,
  options: async ctx => {
    const sizes = await herokuGet('dyno-sizes', ctx)
    return sizes
  },
}

export const FileCompletion: Completion = {
  skipCache: true,

  options: async () => {
    const files = await deps.file.readdir(process.cwd())
    return files
  },
}

export const PipelineCompletion: Completion = {
  cacheDuration: oneDay,
  options: async ctx => {
    const pipelines = await herokuGet('pipelines', ctx)
    return pipelines
  },
}

export const ProcessTypeCompletion: Completion = {
  skipCache: true,

  options: async () => {
    let types: string[] = []
    const procfile = path.join(process.cwd(), 'Procfile')
    try {
      const buff = await deps.file.readFile(procfile)
      types = buff
      .toString()
      .split('\n')
      .map(s => {
        if (!s) return false
        const m = s.match(/^([\w-]+)/)
        return m ? m[0] : false
      })
      .filter(t => t) as string[]
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    return types
  },
}

export const RegionCompletion: Completion = {
  cacheDuration: oneDay * 7,
  options: async ctx => {
    const regions = await herokuGet('regions', ctx)
    return regions
  },
}

export const RemoteCompletion: Completion = {
  skipCache: true,

  options: async () => {
    const remotes = getGitRemotes(configRemote())
    return remotes.map(r => r.remote)
  },
}

export const RoleCompletion: Completion = {
  skipCache: true,

  options: async () => {
    return ['admin', 'collaborator', 'member', 'owner']
  },
}

export const ScopeCompletion: Completion = {
  skipCache: true,

  options: async () => {
    return ['global', 'identity', 'read', 'write', 'read-protected', 'write-protected']
  },
}

export const SpaceCompletion: Completion = {
  cacheDuration: oneDay,
  options: async ctx => {
    const spaces = await herokuGet('spaces', ctx)
    return spaces
  },
}

export const StackCompletion: Completion = {
  cacheDuration: oneDay,
  options: async ctx => {
    const stacks = await herokuGet('stacks', ctx)
    return stacks
  },
}

export const StageCompletion: Completion = {
  skipCache: true,

  options: async () => {
    return ['test', 'review', 'development', 'staging', 'production']
  },
}

export const TeamCompletion: Completion = {
  cacheDuration: oneDay,
  options: async ctx => {
    const teams = await herokuGet('teams', ctx)
    return teams
  },
}
