import {expect} from 'chai'

import {Mutex} from '../src/mutex'

let output: string[]

beforeEach(() => {
  output = []
})

describe('mutex', () => {
  it('should run promises in order', () => {
    let mutex = new Mutex()
    return Promise.all([
      mutex.synchronize(() => {
        return new Promise(resolve => {
          setTimeout(() => {
            output.push('foo')
            resolve('foo')
          }, 3)
        })
      }),
      mutex.synchronize(() => {
        return new Promise(resolve => {
          setTimeout(() => {
            output.push('bar')
            resolve('bar')
          }, 1)
        })
      }),
    ]).then(results => {
      expect(['foo', 'bar']).to.deep.equal(results)
      expect(output).to.deep.equal(['foo', 'bar'])
    })
  })

  it('should propegate errors', () => {
    let mutex = new Mutex()
    return Promise.all([
      mutex.synchronize(() => {
        return new Promise(resolve => {
          output.push('foo')
          resolve('foo')
        })
      }),
      mutex.synchronize(() => {
        return new Promise((_, reject) => {
          output.push('bar')
          reject(new Error('bar'))
        })
      }),
      mutex.synchronize(() => {
        return new Promise(resolve => {
          output.push('biz')
          resolve('biz')
        })
      }),
    ])
      .then(() => {
        throw new Error('x')
      })
      .catch(err => {
        expect(err.message).to.deep.equal('bar')
        expect(output).to.deep.equal(['foo', 'bar', 'biz'])
      })
  })

  it('should run promises after draining the queue', done => {
    let mutex = new Mutex()
    mutex
      .synchronize(() => {
        return new Promise(resolve => {
          output.push('foo')
          resolve('foo')
        })
      })
      .then(results => {
        setImmediate(() => {
          expect('foo').to.deep.equal(results)
          expect(output).to.deep.equal(['foo'])

          return mutex
            .synchronize(() => {
              return new Promise(resolve => {
                output.push('bar')
                resolve('bar')
              })
            })
            .then(results => {
              expect('bar').to.deep.equal(results)
              expect(output).to.deep.equal(['foo', 'bar'])
              done()
            })
        })
      })
  })
})
