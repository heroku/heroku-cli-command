import {flags} from '@oclif/command'

export const team = flags.build({
  char: 't',
  description: 'team to use',

  default: ({flags}) => {
    let {HEROKU_ORGANIZATION: org, HEROKU_TEAM: team} = process.env
    if (team) return team
    if (org) return org
    if (flags.org) return flags.org
  },
})
