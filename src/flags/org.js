// @flow

import {type Flag} from 'cli-engine-command/lib/flags'

type Options = $Shape<Flag<string>>
export default function OrgFlag (options: Options = {}, env: typeof process.env = process.env): Flag<string> {
  const envTeam = env.HEROKU_ORGANIZATION
  const defaultOptions: Options = {
    char: 'o',
    description: 'org to use',
    parse: (input, cmd) => {
      if (input) return input
      if (envTeam) return envTeam
      let team = cmd ? cmd.flags.team : undefined
      if (team) return team
      if (options.required) throw new Error('No org specified')
    }
  }
  return Object.assign(defaultOptions, options)
}
