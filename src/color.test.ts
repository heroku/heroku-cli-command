import { color } from './color'

jest.mock('supports-color', () => {
  return jest.fn()
})

describe('with 256 color', () => {
  beforeEach(() => {
    const supports = require('supports-color')
    const chalk = require('chalk')
    chalk.enabled = true
    supports.has256 = true
    supports.hasBasic = true
    supports.level = 2
  })
  test('gets colors', () => {
    expect(color.app('myapp')).toEqual('\u001b[38;5;104m⬢ myapp\u001b[0m')
  })
})

describe('with basic colors', () => {
  beforeEach(() => {
    const supports = require('supports-color')
    const chalk = require('chalk')
    chalk.enabled = true
    supports.has256 = false
    supports.hasBasic = true
    supports.level = 1
  })
  test('gets colors', () => {
    expect(color.app('myapp')).toEqual('\u001b[35m⬢ myapp\u001b[39m')
  })
})
