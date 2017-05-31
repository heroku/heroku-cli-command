// @flow

import {merge, type Flag} from 'cli-engine-command/lib/flags'

type Options = $Shape<Flag<string>>
export default function TeamFlag (options: Options = {}, env: typeof process.env = process.env): Flag<string> {
  const defaultOptions: Options = {
    char: 't',
    description: 'team to use',
    parse: (input, cmd) => {
      if (input) return input
      if (env.HEROKU_TEAM) return env.HEROKU_TEAM
      if (cmd && cmd.flags.org) return cmd.flags.org
      if (env.HEROKU_ORGANIZATION) return env.HEROKU_ORGANIZATION
      if (options.required) throw new Error('No team specified')
    }
  }
  return merge(defaultOptions, options)
}
