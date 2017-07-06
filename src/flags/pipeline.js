// @flow

import { merge, type Flag } from 'cli-engine-command/lib/flags'

type Options = $Shape<Flag<string>>
export default function PipelineFlag (options: Options = {}, env: typeof process.env = process.env): Flag<string> {
  const defaultOptions: Options = {
    char: 'p',
    parse: (input, cmd) => {
      if (input) return input
      if (options.required) throw new Error('No pipeline specified')
    }
  }
  return merge(defaultOptions, options)
}
