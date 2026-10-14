import * as Flags from '@oclif/core/flags'

export const org = Flags.custom({
  char: 'o',
  default: () => process.env.HEROKU_ORGANIZATION,
  description: 'name of org',
  hidden: true,
  // the default depends on the local environment, so keep it out of generated docs and manifests
  noCacheDefault: true,
})
