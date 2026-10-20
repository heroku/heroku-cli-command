/* eslint-disable n/no-extraneous-import, n/no-unpublished-import, import-x/no-extraneous-dependencies -- the fixture has its own package.json so it loads as a standalone oclif plugin; @oclif/core is resolved from the repo root, not this fixture's deps */
import {Command} from '@oclif/core/command'

import * as flags from '../../../../src/flags/index.js'

export default class Demo extends Command {
  static flags = {
    app: flags.app({required: true}),
    org: flags.org(),
    team: flags.team(),
  }

  async run() {}
}
