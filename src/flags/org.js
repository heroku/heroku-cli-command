// @flow

import {merge, type Flag} from 'cli-engine-command/lib/flags'

type Options = $Shape<Flag<string>>
export default function OrgFlag (options: Options = {}, env: typeof process.env = process.env): Flag<string> {
  const envTeam = env.HEROKU_ORGANIZATION
  const defaultOptions: Options = {
    char: 'o',
    hidden: true,
    parse: (input, cmd) => {
      if (input) return input
      if (envTeam) return envTeam
      if (options.required) throw new Error('No org specified')
    }
  }
  return merge(defaultOptions, options)
}
