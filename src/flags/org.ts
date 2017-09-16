import { option } from 'cli-flags'

export const org = option({
  description: 'name of org',
  char: 'o',
  hidden: true,
  default: () => process.env.HEROKU_ORGANIZATION,
  parse: input => input,
})
