// @flow

import type {Completion} from 'cli-engine-command/lib/completion'
import Heroku from './api_client'

const oneDay = 60 * 60 * 24

function _listGitRemotes (args: string[] = ['remote']): Promise<string> {
  const { execFile } = require('child_process')
  return new Promise(function (resolve, reject) {
    execFile('git', args, function (error, stdout, stderr) {
      process.stderr.write(stderr)
      if (error) return resolve('')
      resolve(stdout)
    })
  })
}

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
    let remotes = await _listGitRemotes()
    return remotes.split('\n').filter(r => r)
  }
}

export const SpaceCompletion: Completion = {
  cacheDuration: oneDay,
  options: async (ctx) => {
    let spaces = await _herokuGet('spaces', ctx)
    return spaces
  }
}

export const TeamCompletion: Completion = {
  cacheDuration: oneDay,
  options: async (ctx) => {
    let teams = await _herokuGet('teams', ctx)
    return teams
  }
}
