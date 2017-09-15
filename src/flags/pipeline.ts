import { option } from 'cli-flags'

export const pipeline = option({
  parse: input => input,
  char: 'p',
  description: 'name of pipeline',
})
