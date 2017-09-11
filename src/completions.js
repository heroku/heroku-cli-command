// @flow

import type {Config, Completion} from 'cli-engine-config'
import Heroku from './api_client'
import {configRemote, getGitRemotes} from './flags/app'
import fs from 'fs-extra'
import path from 'path'

const oneDay = 60 * 60 * 24

export const _herokuGet = async function (resource: string, ctx: {config: Config}): Promise<Array<string>> {
  const heroku = new Heroku({config: ctx.config})
  let {body: resources} = await heroku.get(`/${resource}`)
  if (typeof resources === 'string') resources = JSON.parse(resources)
  return resources.map(a => a.name).sort()
}

export const AppCompletion: Completion = {
  cacheDuration: oneDay,
  options: async (ctx) => {
    let apps = await _herokuGet('apps', ctx)
    return apps
  }
}

export const BuildpackCompletion: Completion = {
  skipCache: true,
  options: async (ctx) => {
    return ['heroku/ruby', 'heroku/nodejs', 'heroku/clojure', 'heroku/python', 'heroku/java', 'heroku/gradle', 'heroku/scala', 'heroku/php', 'heroku/go']
  }
}

export const AppAddonCompletion: Completion = {
  cacheDuration: oneDay,
  cacheKey: async (ctx) => {
    return (ctx.flags && ctx.flags.app) ? `${ctx.flags.app}_addons` : ''
  },
  options: async (ctx) => {
    const heroku = new Heroku({config: ctx.config})
    let addons = (ctx.flags && ctx.flags.app) ? await heroku.get(`/apps/${ctx.flags.app}/addons`) : []
    return addons.map(a => a.name).sort()
  }
}

export const AppDynoCompletion: Completion = {
  cacheDuration: oneDay,
  cacheKey: async (ctx) => {
    return (ctx.flags && ctx.flags.app) ? `${ctx.flags.app}_dynos` : ''
  },
  options: async (ctx) => {
    const heroku = new Heroku({config: ctx.config})
    let dynos = (ctx.flags && ctx.flags.app) ? await heroku.get(`/apps/${ctx.flags.app}/dynos`) : []
    return dynos.map(a => a.type).sort()
  }
}

export const DynoSizeCompletion: Completion = {
  cacheDuration: oneDay * 90,
  options: async (ctx) => {
    let sizes = await _herokuGet('dyno-sizes', ctx)
    return sizes
  }
}

export const FileCompletion: Completion = {
  skipCache: true,
  options: async (ctx) => {
    let files = await fs.readdir(process.cwd())
    return files
  }
}

export const PipelineCompletion: Completion = {
  cacheDuration: oneDay,
  options: async (ctx) => {
    let pipelines = await _herokuGet('pipelines', ctx)
    return pipelines
  }
}

export const ProcessTypeCompletion: Completion = {
  skipCache: true,
  options: async (ctx) => {
    let types = []
    let procfile = path.join(process.cwd(), 'Procfile')
    if (await fs.exists(procfile)) {
      let buff = await fs.readFile(procfile)
      types = buff.toString().split('\n').map(s => {
        if (!s) return false
        let m = s.match(/^([A-Za-z0-9_-]+)/)
        return m ? m[0] : false
      }).filter(t => t)
    }
    return types
  }
}

export const RegionCompletion: Completion = {
  cacheDuration: oneDay * 7,
  options: async (ctx) => {
    let regions = await _herokuGet('regions', ctx)
    return regions
  }
}

export const RemoteCompletion: Completion = {
  skipCache: true,
  options: async (ctx) => {
    let remotes = getGitRemotes(configRemote())
    return remotes.map(r => r.remote)
  }
}

export const RoleCompletion: Completion = {
  skipCache: true,
  options: async (ctx) => {
    return ['admin', 'collaborator', 'member', 'owner']
  }
}

export const ScopeCompletion: Completion = {
  skipCache: true,
  options: async (ctx) => {
    return ['global', 'identity', 'read', 'write', 'read-protected', 'write-protected']
  }
}

export const SpaceCompletion: Completion = {
  cacheDuration: oneDay,
  options: async (ctx) => {
    let spaces = await _herokuGet('spaces', ctx)
    return spaces
  }
}

export const StackCompletion: Completion = {
  cacheDuration: oneDay,
  options: async (ctx) => {
    let stacks = await _herokuGet('stacks', ctx)
    return stacks
  }
}

export const StageCompletion: Completion = {
  skipCache: true,
  options: async (ctx) => {
    return ['test', 'review', 'development', 'staging', 'production']
  }
}

export const TeamCompletion: Completion = {
  cacheDuration: oneDay,
  options: async (ctx) => {
    let teams = await _herokuGet('teams', ctx)
    return teams
  }
}
