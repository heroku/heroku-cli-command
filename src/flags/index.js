// @flow

import {flags as baseFlags} from 'cli-engine-command'
import {app, remote} from './app'
import team from './team'
import org from './org'
import pipeline from './pipeline'

export default {
  app,
  remote,
  org,
  team,
  pipeline,
  boolean: baseFlags.boolean,
  number: baseFlags.number,
  string: baseFlags.string
}
