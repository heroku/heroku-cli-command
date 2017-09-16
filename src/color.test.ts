import { color } from './color'

jest.mock('supports-color', () => {
  return jest.fn()
})

describe('with 256 color', () => {
  beforeEach(() => {
    require('supports-color').has256 = true
  })
  test('gets colors', () => {
    expect(color.app('myapp')).toEqual('\u001b[38;5;104m⬢ myapp\u001b[0m')
  })
})
