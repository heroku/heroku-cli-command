// the fixture needs its own package.json to load as an oclif plugin, so import rules treat it as a separate package
/* eslint-disable n/no-extraneous-import, n/no-unpublished-import */
import {Command} from '@oclif/core/command'

import * as flags from '../../../../src/flags/index.js'

export default class Demo extends Command {
  static flags = {
    app: flags.app({required: true}),
  }

  async run() {}
}
