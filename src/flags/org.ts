import {flags} from '@anycli/command'

export const org = flags.build({
  char: 'o',
  default: () => process.env.HEROKU_ORGANIZATION,
  description: 'name of org',
  hidden: true,
})
