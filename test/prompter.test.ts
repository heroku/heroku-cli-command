import {expect} from 'chai'
import {PassThrough} from 'node:stream'
import {stderr, stdout} from 'stdout-stderr'

import {prompter} from '../src/prompter.js'

describe('prompter', () => {
  it('writes prompt UI to stderr, not stdout', async () => {
    // Fake stdin that immediately answers the prompt.
    const fakeStdin = new PassThrough()
    setImmediate(() => {
      fakeStdin.write('123456\n')
    })

    stdout.start()
    stderr.start()
    try {
      const result = await prompter.prompt<{factor: string}>(
        [{
          message: 'Two-factor code',
          name: 'factor',
          type: 'input',
        }],
        // Allow tests to override the input stream so we don't block on a TTY.
        {input: fakeStdin as unknown as NodeJS.ReadableStream},
      )

      expect(result.factor).to.equal('123456')
      expect(stderr.output).to.contain('Two-factor code')
      expect(stdout.output).to.not.contain('Two-factor code')
    } finally {
      stdout.stop()
      stderr.stop()
    }
  })
})
