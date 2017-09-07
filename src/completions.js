// @flow

import type {Completion} from 'cli-engine-command/lib/completion'
import Heroku from './api_client'
import {configRemote, getGitRemotes} from './flags/app'

const oneDay = 60 * 60 * 24

export const _herokuGet = async function (resource: string, ctx: {out: any}): Promise<Array<string>> {
  const heroku = new Heroku({out: ctx.out})
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

export const PipelineCompletion: Completion = {
  cacheDuration: oneDay,
  options: async (ctx) => {
    let pipelines = await _herokuGet('pipelines', ctx)
    return pipelines
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
  cacheDuration: 1, // fetch git remote(s) everytime
  options: async (ctx) => {
    let remotes = getGitRemotes(configRemote())
    return remotes.map(r => r.remote)
  }
}

export const RoleCompletion: Completion = {
  cacheDuration: oneDay * 365, // cache once
  options: async (ctx) => {
    return ['admin', 'collaborator', 'member', 'owner']
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
    let spaces = await _herokuGet('stacks', ctx)
    return spaces
  }
}

export const StageCompletion: Completion = {
  cacheDuration: oneDay * 365, // cache once
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
