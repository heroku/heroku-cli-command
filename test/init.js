const cli = require('cli-ux')

process.env.FORCE_COLOR = 1
const nock = require('nock')
nock.disableNetConnect()

beforeEach(() => {
  cli.default.config.mock = true
})
