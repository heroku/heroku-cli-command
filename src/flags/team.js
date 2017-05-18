// @flow

import {type Flag} from 'cli-engine-command/lib/flags'

type Options = $Shape<Flag<string>>
export default function TeamFlag (options: Options = {}, env: typeof process.env = process.env): Flag<string> {
  const envTeam = env.HEROKU_TEAM || env.HEROKU_ORGANIZATION
  const defaultOptions: Options = {
    name: 'team',
    char: 't',
    description: 'team to use',
    default: () => envTeam,
    parse: (input) => {
      if (input) return input
      if (envTeam) return envTeam
      if (options.required) throw new Error('No team specified')
    }
  }
  return Object.assign(defaultOptions, options)
}
