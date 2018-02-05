import {expect} from 'chai'

import {Command, flags} from '../src'

describe('index', () => {
  it('has flags', async () => {
    expect(flags).to.be.ok
    expect(typeof flags.team).to.equal('function')
    expect(typeof flags.org).to.equal('function')
  })

  it('has Command', async () => {
    expect(typeof Command).to.equal('function')
  })
})
