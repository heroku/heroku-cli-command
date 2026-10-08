import {expect} from 'chai'

import {Mutex} from '../src/mutex.js'

let output: string[]

beforeEach(() => {
  output = []
})

describe('mutex', () => {
  it('should run promises in order', async () => {
    const mutex = new Mutex()
    return Promise.all([
      mutex.synchronize(async () => new Promise(resolve => {
        setTimeout(() => {
          output.push('foo')
          resolve('foo')
        }, 3)
      })),
      mutex.synchronize(async () => new Promise(resolve => {
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

  it('should propegate errors', async () => {
    const mutex = new Mutex()
    return Promise.all([
      mutex.synchronize(async () => new Promise(resolve => {
        output.push('foo')
        resolve('foo')
      })),
      mutex.synchronize(async () => new Promise((_, reject) => {
        output.push('bar')
        reject(new Error('bar'))
      })),
      mutex.synchronize(async () => new Promise(resolve => {
        output.push('biz')
        resolve('biz')
      })),
    ])
      .then(() => {
        throw new Error('x')
      })
      .catch((error: unknown) => {
        expect((error as Error).message).to.deep.equal('bar')
        expect(output).to.deep.equal(['foo', 'bar', 'biz'])
      })
  })

  it('should run promises after draining the queue', done => {
    const mutex = new Mutex()
    mutex
      .synchronize(async () => new Promise(resolve => {
        output.push('foo')
        resolve('foo')
      }))
      .then(results => {
        setImmediate(() => {
          expect('foo').to.deep.equal(results)
          expect(output).to.deep.equal(['foo'])

          void mutex
            .synchronize(async () => new Promise(resolve => {
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

  it('rejects the caller and keeps draining when a task throws synchronously', async () => {
    const mutex = new Mutex<string>()

    let caught: unknown
    await mutex
      .synchronize(() => {
        throw new Error('sync boom')
      })
      .catch((error: unknown) => {
        caught = error
      })

    expect((caught as Error).message).to.equal('sync boom')

    // The queue must not stall: a task queued after the throwing one still runs.
    const result = await mutex.synchronize(async () => {
      output.push('after-throw')
      return 'ok'
    })
    expect(result).to.equal('ok')
    expect(output).to.deep.equal(['after-throw'])
  })
})
