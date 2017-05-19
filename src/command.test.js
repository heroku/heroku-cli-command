// @flow

import Base from './command'
import {flags} from 'cli-engine-command'

class Command extends Base {
  static flags = {
    app: flags.app()
  }
}

test('sets app', async () => {
  let cmd = await Command.mock('--app=myapp')
  expect(cmd.app).toEqual('myapp')
})
