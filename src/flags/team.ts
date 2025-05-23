import {Flags} from '@oclif/core'

export const team = Flags.custom({
  char: 't',
  async default({flags}) {
    const {HEROKU_ORGANIZATION: org, HEROKU_TEAM: team} = process.env
    if (flags.org) return flags.org
    if (team) return team
    if (org) return org
  },
  description: 'team to use',
})
