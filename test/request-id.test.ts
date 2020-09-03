import {expect} from 'chai'

import {RequestId} from '../src/request-id'

describe('getRequestId', () => {
  it('returns the same uuids after multiple calls', async () => {
    const requestId = RequestId.id
    expect(requestId).to.be.a('string')
    expect(requestId.length).to.equal(36)
  })
})
