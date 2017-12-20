import deps from './deps'
import * as path from 'path'
import { flags } from 'cli-engine-command'
import { Config } from 'cli-engine-config'

export { AppCompletion, RemoteCompletion } from './flags/app'

export const oneDay = 60 * 60 * 24

export const _herokuGet = async function(resource: string, ctx: { config: Config }): Promise<Array<string>> {
  const heroku = new deps.APIClient({ config: ctx.config })
  let { body: resources } = await heroku.get(`/${resource}`)
  if (typeof resources === 'string') resources = JSON.parse(resources)
  return resources.map((a: any) => a.name).sort()
}

export const BuildpackCompletion: flags.Completion = {
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

export const AppAddonCompletion: flags.Completion = {
  cacheDuration: oneDay,
  cacheKey: async ctx => {
    return ctx.flags && ctx.flags.app ? `${ctx.flags.app}_addons` : ''
  },
  options: async ctx => {
    const heroku = new deps.APIClient({ config: ctx.config })
    let addons = ctx.flags && ctx.flags.app ? await heroku.get(`/apps/${ctx.flags.app}/addons`) : []
    return (<any>addons).map((a: any) => a.name).sort()
  },
}

export const AppDynoCompletion: flags.Completion = {
  cacheDuration: oneDay,
  cacheKey: async ctx => {
    return ctx.flags && ctx.flags.app ? `${ctx.flags.app}_dynos` : ''
  },
  options: async ctx => {
    const heroku = new deps.APIClient({ config: ctx.config })
    let dynos = ctx.flags && ctx.flags.app ? await heroku.get(`/apps/${ctx.flags.app}/dynos`) : []
    return (<any>dynos).map((a: any) => a.type).sort()
  },
}

export const DynoSizeCompletion: flags.Completion = {
  cacheDuration: oneDay * 90,
  options: async ctx => {
    let sizes = await _herokuGet('dyno-sizes', ctx)
    return sizes
  },
}

export const FileCompletion: flags.Completion = {
  skipCache: true,
  options: async () => {
    let files = await deps.file.readdir(process.cwd())
    return files
  },
}

export const PipelineCompletion: flags.Completion = {
  cacheDuration: oneDay,
  options: async ctx => {
    let pipelines = await _herokuGet('pipelines', ctx)
    return pipelines
  },
}

export const ProcessTypeCompletion: flags.Completion = {
  skipCache: true,
  options: async () => {
    let types: string[] = []
    let procfile = path.join(process.cwd(), 'Procfile')
    try {
      let buff = await deps.file.readFile(procfile)
      types = buff
        .toString()
        .split('\n')
        .map(s => {
          if (!s) return false
          let m = s.match(/^([A-Za-z0-9_-]+)/)
          return m ? m[0] : false
        })
        .filter(t => t) as string[]
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    return types
  },
}

export const RegionCompletion: flags.Completion = {
  cacheDuration: oneDay * 7,
  options: async ctx => {
    let regions = await _herokuGet('regions', ctx)
    return regions
  },
}

export const RoleCompletion: flags.Completion = {
  skipCache: true,
  options: async () => {
    return ['admin', 'collaborator', 'member', 'owner']
  },
}

export const ScopeCompletion: flags.Completion = {
  skipCache: true,
  options: async () => {
    return ['global', 'identity', 'read', 'write', 'read-protected', 'write-protected']
  },
}

export const SpaceCompletion: flags.Completion = {
  cacheDuration: oneDay,
  options: async ctx => {
    let spaces = await _herokuGet('spaces', ctx)
    return spaces
  },
}

export const StackCompletion: flags.Completion = {
  cacheDuration: oneDay,
  options: async ctx => {
    let stacks = await _herokuGet('stacks', ctx)
    return stacks
  },
}

export const StageCompletion: flags.Completion = {
  skipCache: true,
  options: async () => {
    return ['test', 'review', 'development', 'staging', 'production']
  },
}

export const TeamCompletion: flags.Completion = {
  cacheDuration: oneDay,
  options: async ctx => {
    let teams = await _herokuGet('teams', ctx)
    return teams
  },
}
