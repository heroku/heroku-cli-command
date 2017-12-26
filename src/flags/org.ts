import { flags } from '@cli-engine/command'

export const org = flags.option({
  char: 'o',
  default: () => process.env.HEROKU_ORGANIZATION,
  description: 'name of org',
  hidden: true,
})
