// @flow

import cp from 'child_process'
import yubikey from './yubikey'

jest.mock('child_process')

describe('yubikey', () => {
  beforeEach(() => {
    yubikey.platform = 'darwin'
  })
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('turns yubikey on', () => {
    expect.assertions(2)

    cp.execSync.mockImplementationOnce((args, opts) => {
      expect(args).toEqual("osascript -e 'if application \"yubiswitch\" is running then tell application \"yubiswitch\" to KeyOn'")
      expect(opts).toEqual({ stdio: 'inherit' })
    })
    yubikey.enable()
  })

  it('turns yubikey off', () => {
    expect.assertions(2)

    cp.execSync.mockImplementationOnce((args, opts) => {
      expect(args).toEqual("osascript -e 'if application \"yubiswitch\" is running then tell application \"yubiswitch\" to KeyOff'")
      expect(opts).toEqual({ stdio: 'inherit' })
    })
    yubikey.disable()
  })
})
