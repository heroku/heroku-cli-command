import * as Flags from '@oclif/core/flags'

export const org = Flags.custom({
  char: 'o',
  default: () => process.env.HEROKU_ORGANIZATION,
  description: 'name of org',
  hidden: true,
})
