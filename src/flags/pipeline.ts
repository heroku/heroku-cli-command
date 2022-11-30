import {Flags} from '@oclif/core'

export const pipeline = Flags.custom({
  char: 'p',
  description: 'name of pipeline',
})
