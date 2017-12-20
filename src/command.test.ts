import { Command } from './command'
import * as flags from './flags'

let m: jest.Mock<void>
beforeEach(() => {
  m = jest.fn()
})

class AppCommand extends Command {
  static flags = {
    app: flags.app(),
  }

  async run() {
    m(this.app)
  }
}

test('sets app', async () => {
  await AppCommand.mock('--app=myapp')
  expect(m).toBeCalledWith('myapp')
})

test('has heroku clients', async () => {
  let { cmd } = await AppCommand.mock('--app=myapp')
  expect(cmd.heroku).toBeTruthy()
  expect(cmd.legacyHerokuClient).toBeTruthy()
})
