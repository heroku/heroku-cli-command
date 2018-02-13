import {flags} from '@oclif/command'

export const pipeline = flags.build({
  char: 'p',
  description: 'name of pipeline',
})
