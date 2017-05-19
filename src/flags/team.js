// @flow

import {type Flag} from 'cli-engine-command/lib/flags'

type Options = $Shape<Flag<string>>
export default function TeamFlag (options: Options = {}, env: typeof process.env = process.env): Flag<string> {
  const envTeam = env.HEROKU_TEAM || env.HEROKU_ORGANIZATION
  const defaultOptions: Options = {
    char: 't',
    description: 'team to use',
    parse: (input, cmd) => {
      if (input) return input
      if (envTeam) return envTeam
      let org = cmd ? cmd.flags.org : undefined
      if (org) return org
      if (options.required) throw new Error('No team specified')
    }
  }
  return Object.assign(defaultOptions, options)
}
