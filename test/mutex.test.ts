import {expect} from 'chai'

import {Mutex} from '../src/mutex.js'

let output: string[]

beforeEach(() => {
  output = []
})

describe('mutex', () => {
  it('should run promises in order', () => {
    const mutex = new Mutex()
    return Promise.all([
      mutex.synchronize(() => new Promise(resolve => {
        setTimeout(() => {
          output.push('foo')
          resolve('foo')
        }, 3)
      })),
      mutex.synchronize(() => new Promise(resolve => {
        setTimeout(() => {
          output.push('bar')
          resolve('bar')
        }, 1)
      })),
    ]).then(results => {
      expect(['foo', 'bar']).to.deep.equal(results)
      expect(output).to.deep.equal(['foo', 'bar'])
    })
  })

  it('should propegate errors', () => {
    const mutex = new Mutex()
    return Promise.all([
      mutex.synchronize(() => new Promise(resolve => {
        output.push('foo')
        resolve('foo')
      })),
      mutex.synchronize(() => new Promise((_, reject) => {
        output.push('bar')
        reject(new Error('bar'))
      })),
      mutex.synchronize(() => new Promise(resolve => {
        output.push('biz')
        resolve('biz')
      })),
    ])
      .then(() => {
        throw new Error('x')
      })
      .catch(error => {
        expect(error.message).to.deep.equal('bar')
        expect(output).to.deep.equal(['foo', 'bar', 'biz'])
      })
  })

  it('should run promises after draining the queue', done => {
    const mutex = new Mutex()
    mutex
      .synchronize(() => new Promise(resolve => {
        output.push('foo')
        resolve('foo')
      }))
      .then(results => {
        setImmediate(() => {
          expect('foo').to.deep.equal(results)
          expect(output).to.deep.equal(['foo'])

          return mutex
            .synchronize(() => new Promise(resolve => {
              output.push('bar')
              resolve('bar')
            }))
            .then(results => {
              expect('bar').to.deep.equal(results)
              expect(output).to.deep.equal(['foo', 'bar'])
              done()
            })
        })
      })
      .catch(done)
  })
})
