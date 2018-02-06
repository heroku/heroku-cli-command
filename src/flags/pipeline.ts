import {flags} from '@anycli/command'

export const pipeline = flags.build({
  char: 'p',
  description: 'name of pipeline',
})
