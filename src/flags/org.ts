import {flags} from '@oclif/command'

export const org = flags.build({
  char: 'o',
  default: () => process.env.HEROKU_ORGANIZATION,
  description: 'name of org',
  hidden: true,
})
