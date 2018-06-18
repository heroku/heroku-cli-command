import {flags} from '@oclif/command'

import {TeamCompletion} from '../completions'

export const team = flags.build({
  char: 't',
  completion: TeamCompletion,
  description: 'team to use',

  default: ({flags}) => {
    let {HEROKU_ORGANIZATION: org, HEROKU_TEAM: team} = process.env
    if (team) return team
    if (org) return org
    if (flags.org) return flags.org
  },
})
