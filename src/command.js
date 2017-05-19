// @flow

import Command from 'cli-engine-command'

export default class HerokuCommand extends Command {
  app: ?string

  async init () {
    await super.init()
    if (this.flags.app) this.app = this.flags.app
  }
}
