import nock from 'nock'
import {resolve} from 'node:path'

/** Mirrors @heroku-cli/test-utils initCliTest (not a devDependency here to avoid cycle with this package). */
export const mochaHooks = {
  beforeEach(done: () => void) {
    process.env.TS_NODE_PROJECT = resolve('test/tsconfig.json')
    Object.assign(globalThis, {columns: '120'})
    nock.disableNetConnect()
    if (process.env.ENABLE_NET_CONNECT === 'true') {
      nock.enableNetConnect()
    }

    done()
  },
}
