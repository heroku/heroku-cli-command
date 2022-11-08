import {Flags} from '@oclif/core'

export const org = Flags.custom({
  char: 'o',
  default: () => process.env.HEROKU_ORGANIZATION,
  description: 'name of org',
  hidden: true,
})
