import { flags as baseFlags } from 'cli-engine-command'
import { app, remote } from './app'
import { team } from './team'
import { org } from './org'
import { pipeline } from './pipeline'

export const flags = {
  ...baseFlags,
  app,
  remote,
  org,
  team,
  pipeline,
}
