import {Flags} from '@oclif/core'

export const pipeline = Flags.build({
  char: 'p',
  description: 'name of pipeline',
})
