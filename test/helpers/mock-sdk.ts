import {HerokuSDK} from '@heroku/sdk'
import {type SinonStub, stub} from 'sinon'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StubbedPlatformClient = Record<string, any>

export type MockSDK = {
  platformStub: SinonStub;
  restore: () => void;
}

/** Replaces `HerokuSDK.prototype.platform` with a fake so completion sources run against it (no network). */
export function mockSDKPlatform(fakePlatform: StubbedPlatformClient): MockSDK {
  const platformStub = stub(HerokuSDK.prototype, 'platform').get(() => fakePlatform)
  return {
    platformStub,
    restore() {
      platformStub.restore()
    },
  }
}
