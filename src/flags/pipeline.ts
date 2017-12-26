import { flags } from '@cli-engine/command'

export const pipeline = flags.option({
  char: 'p',
  description: 'name of pipeline',
})
