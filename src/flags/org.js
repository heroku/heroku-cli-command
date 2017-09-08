// @flow

import type {OptionFlag} from 'cli-engine-config'

type Options = $Shape<OptionFlag<string>>
export default function OrgFlag (options: Options = {}): OptionFlag<string> {
  return {
    char: 'o',
    hidden: true,
    parse: input => {
      if (input) return input
      if (process.env.HEROKU_ORGANIZATION) return process.env.HEROKU_ORGANIZATION
    },
    ...options
  }
}
