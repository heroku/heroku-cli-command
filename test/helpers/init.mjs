import nock from 'nock'
import {resolve} from 'path'

process.env.NODE_ENV = 'test'
process.env.TS_NODE_PROJECT = resolve('test/tsconfig.json')
Object.assign(globalThis, {columns: '120'})
nock.disableNetConnect()
if (process.env.ENABLE_NET_CONNECT === 'true') {
  nock.enableNetConnect()
}
