import { FlagBuilder } from 'cli-flags'
import { flags } from 'cli-engine-command'

export const pipeline: FlagBuilder<string> = flags.option({
  char: 'p',
  description: 'name of pipeline',
})
