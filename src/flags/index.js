// @flow

import {flags as baseFlags} from 'cli-engine-command'
import {app, remote} from './app'
import team from './team'
import org from './org'

export {default as merge} from 'lodash.merge'

export default {
  app,
  remote,
  org,
  team,
  boolean: baseFlags.boolean,
  number: baseFlags.number,
  string: baseFlags.string
}
