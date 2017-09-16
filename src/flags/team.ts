import { TeamCompletion } from '../completions'
import { flags } from 'cli-engine-command'

export const team = flags.option({
  description: 'team to use',
  char: 't',
  default: ({ input }) => {
    let { HEROKU_ORGANIZATION: org, HEROKU_TEAM: team } = process.env
    if (team) return team
    if (org) return org
    if (input.flags.org && input.flags.org.input[0]) return input.flags.org.input[0]
  },
  completion: TeamCompletion,
})
