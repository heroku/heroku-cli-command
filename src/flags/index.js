// @flow

import {flags as baseFlags} from 'cli-engine-command'
import {app, remote} from './app'
import team from './team'
import org from './org'

export {merge} from 'cli-engine-command/lib/flags'

export default {
  app,
  remote,
  org,
  team,
  boolean: baseFlags.boolean,
  number: baseFlags.number,
  string: baseFlags.string
}
