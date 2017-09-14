import {Mutex} from './mutex'

let output: string[]

beforeEach(() => {
  output = []
})

describe('mutex', function () {
  it('should run promises in order', function () {
    let mutex = new Mutex()
    return Promise.all([
      mutex.synchronize(function () {
        return new Promise(function (resolve) {
          setTimeout(function () {
            output.push('foo')
            resolve('foo')
          }, 3)
        })
      }),
      mutex.synchronize(function () {
        return new Promise(function (resolve) {
          setTimeout(function () {
            output.push('bar')
            resolve('bar')
          }, 1)
        })
      })
    ]).then((results) => {
      expect(['foo', 'bar']).toEqual(results)
      expect(output).toEqual(['foo', 'bar'])
    })
  })

  it('should propegate errors', function () {
    let mutex = new Mutex()
    return Promise.all([
      mutex.synchronize(function () {
        return new Promise(function (resolve) {
          output.push('foo')
          resolve('foo')
        })
      }),
      mutex.synchronize(function () {
        return new Promise(function (_, reject) {
          output.push('bar')
          reject(new Error('bar'))
        })
      }),
      mutex.synchronize(function () {
        return new Promise(function (resolve) {
          output.push('biz')
          resolve('biz')
        })
      })
    ]).then(() => {
      throw new Error('x')
    }).catch((err) => {
      expect(err.message).toEqual('bar')
      expect(output).toEqual(['foo', 'bar', 'biz'])
    })
  })

  it('should run promises after draining the queue', function (done) {
    let mutex = new Mutex()
    mutex.synchronize(function () {
      return new Promise(function (resolve) {
        output.push('foo')
        resolve('foo')
      })
    }).then((results) => {
      setImmediate(function () {
        expect('foo').toEqual(results)
        expect(output).toEqual(['foo'])

        return mutex.synchronize(function () {
          return new Promise(function (resolve) {
            output.push('bar')
            resolve('bar')
          })
        }).then((results) => {
          expect('bar').toEqual(results)
          expect(output).toEqual(['foo', 'bar'])
          done()
        })
      })
    })
  })
})
