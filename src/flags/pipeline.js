// @flow

import type { OptionFlag } from 'cli-engine-config'

type Options = $Shape<OptionFlag<string>>

export default function PipelineFlag (options: Options = {}): OptionFlag<string> {
  return {
    char: 'p',
    description: 'name of pipeline',
    parse: v => v,
    ...options
  }
}
