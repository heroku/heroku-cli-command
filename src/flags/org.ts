import { flags } from 'cli-engine-command'

export const org = flags.option({
  description: 'name of org',
  char: 'o',
  hidden: true,
  default: () => process.env.HEROKU_ORGANIZATION,
})
