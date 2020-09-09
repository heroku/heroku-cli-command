import {expect} from 'chai'
import * as sinon from 'sinon'

import {RequestId} from '../src/request-id'

describe('getRequestId', () => {
  let generateStub: any

  beforeEach(function () {
    RequestId.empty()
    generateStub = sinon.stub(RequestId, '_generate').returns('randomly-generated-uuid')
  })

  afterEach(function () {
    generateStub.restore()
  })

  it('can create random uuids', () => {
    expect(RequestId.ids.length).to.equal(0)
    expect(generateStub.called).to.be.false
    const ids = RequestId.create()
    expect(ids).to.deep.equal(RequestId.ids)
    expect(ids).to.deep.equal(['randomly-generated-uuid'])
    expect(RequestId.ids.length).to.equal(1)
    expect(generateStub.called).to.be.true
  })

  it('can can track ids', () => {
    expect(RequestId.ids.length).to.equal(0)
    RequestId.track('tracked-id', 'another-tracked-id')
    expect(RequestId.ids).to.deep.equal(['tracked-id', 'another-tracked-id'])
  })

  it('can empty the tracked ids', () => {
    expect(RequestId.ids.length).to.equal(0)
    RequestId.create()
    expect(RequestId.ids.length).to.equal(1)
    RequestId.empty()
    expect(RequestId.ids.length).to.equal(0)
  })

  it('can generate a header value', () => {
    RequestId.create()
    RequestId.track('incoming-header-id')
    expect(RequestId.headerValue).to.equal('incoming-header-id,randomly-generated-uuid')
  })

  it('create and track uuids together putting latest in front', () => {
    expect(RequestId.ids.length).to.equal(0)

    generateStub.returns('random')
    let ids = RequestId.create()
    expect(ids).to.deep.equal(['random'])

    ids = RequestId.track('tracked')
    expect(ids).to.deep.equal(['tracked', 'random'])

    generateStub.returns('another-random')
    ids = RequestId.create()
    expect(RequestId.ids).to.deep.equal(['another-random', 'tracked', 'random'])
    expect(RequestId.headerValue).to.deep.equal('another-random,tracked,random')
  })
})
