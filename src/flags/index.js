// @flow

import {flags as baseFlags} from 'cli-engine-command'
import team from './team'
import org from './org'

export const flags = {
  org,
  team,
  boolean: baseFlags.boolean,
  number: baseFlags.number,
  string: baseFlags.string
}
export {default as merge} from 'lodash.merge'
