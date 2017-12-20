import {
  flags as baseFlags,
  FlagBuilder,
  InputFlags,
  IBooleanFlag,
  IRequiredFlag,
  IMultiOptionFlag,
  IOptionalFlag,
} from 'cli-engine-command'
import { app, remote } from './app'
import { team } from './team'
import { org } from './org'
import { pipeline } from './pipeline'

export { FlagBuilder, InputFlags, IBooleanFlag, IRequiredFlag, IMultiOptionFlag, IOptionalFlag }

export const flags = {
  ...baseFlags,
  app: app as FlagBuilder<string>,
  remote: remote as FlagBuilder<string>,
  org: org as FlagBuilder<string>,
  team: team as FlagBuilder<string>,
  pipeline: pipeline as FlagBuilder<string>,
}
