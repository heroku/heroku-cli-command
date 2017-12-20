import { TeamCompletion } from '../completions'
import { flags } from 'cli-engine-command'

export const team = flags.option({
  description: 'team to use',
  char: 't',
  default: ({ flags }) => {
    let { HEROKU_ORGANIZATION: org, HEROKU_TEAM: team } = process.env
    if (team) return team
    if (org) return org
    if (flags.org) return flags.org
  },
  completion: TeamCompletion,
})
