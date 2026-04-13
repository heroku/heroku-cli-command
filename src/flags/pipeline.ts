import * as Flags from '@oclif/core/flags'

export const pipeline = Flags.custom({
  char: 'p',
  description: 'name of pipeline',
})
