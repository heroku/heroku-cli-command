import {Netrc} from 'netrc-parser'
import * as sinon from 'sinon'

const mockNetrc = {
  machines: {
    'api.heroku.com': {
      login: 'test@example.com',
      password: 'mypass',
    },
  },
  saveSync: sinon.stub(),
}

let loadSyncStub: sinon.SinonStub | undefined
let loadStub: sinon.SinonStub | undefined

export function stubNetrc() {
  // Only stub if not already stubbed
  if (typeof (Netrc.prototype.loadSync as any).restore !== 'function') {
    loadSyncStub = sinon.stub(Netrc.prototype, 'loadSync').callsFake(function (this: any) {
      Object.assign(this, mockNetrc)
      return this
    })
  }

  if (typeof (Netrc.prototype.load as any).restore !== 'function') {
    loadStub = sinon.stub(Netrc.prototype, 'load').callsFake(function (this: any) {
      Object.assign(this, mockNetrc)
      return Promise.resolve(this)
    })
  }
}

export function restoreNetrcStub() {
  if (loadSyncStub) {
    loadSyncStub.restore()
    loadSyncStub = undefined
  }

  if (loadStub) {
    loadStub.restore()
    loadStub = undefined
  }
}
