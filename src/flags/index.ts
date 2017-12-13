import { IBooleanFlag, IRequiredFlag, IOptionalFlag, IMultiOptionFlag } from 'cli-flags'
import { flags as baseFlags, FlagBuilder } from 'cli-engine-command'
import { app, remote } from './app'
import { team } from './team'
import { org } from './org'
import { pipeline } from './pipeline'

export { IBooleanFlag, IRequiredFlag, IOptionalFlag, IMultiOptionFlag, FlagBuilder }

export const flags = {
  ...baseFlags,
  app: app as FlagBuilder<string>,
  remote: remote as FlagBuilder<string>,
  org: org as FlagBuilder<string>,
  team: team as FlagBuilder<string>,
  pipeline: pipeline as FlagBuilder<string>,
}
