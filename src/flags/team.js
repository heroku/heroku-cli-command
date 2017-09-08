// @flow

import type {OptionFlag} from 'cli-engine-config'
import {TeamCompletion} from '../completions'

type Options = $Shape<OptionFlag<string>>
export default function TeamFlag (options: Options = {}): OptionFlag<string> {
  return {
    char: 't',
    description: 'team to use',
    parse: (input, cmd, name) => {
      if (input) return input
      if (process.env.HEROKU_TEAM) return process.env.HEROKU_TEAM
      if (cmd && cmd.flags.org) return cmd.flags.org
      if (process.env.HEROKU_ORGANIZATION) return process.env.HEROKU_ORGANIZATION
      if (options.required) throw new Error('No team specified')
    },
    completion: TeamCompletion,
    ...options
  }
}
