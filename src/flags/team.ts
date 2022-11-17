import {Flags} from '@oclif/core'
import {CompletableOptionFlag} from '@oclif/core/lib/interfaces/parser'

import {TeamCompletion} from '../completions'

const teamWithoutCompletion = Flags.custom({
  char: 't',
  description: 'team to use',
  default: async ({flags}) => {
    const {HEROKU_ORGANIZATION: org, HEROKU_TEAM: team} = process.env
    if (flags.org) return flags.org
    if (team) return team
    if (org) return org
  },
})

export const team = (flagArgs: Partial<CompletableOptionFlag<string>> = {}) => teamWithoutCompletion({...flagArgs, completion: TeamCompletion})
