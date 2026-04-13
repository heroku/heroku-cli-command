import {Command} from '@oclif/core/command'
import {expect, fancy} from 'fancy-test'

import * as flags from '../../src/flags/index.js'

describe('no-wrap flag', () => {
  class NoWrapCommand extends Command {
    static flags = {'no-wrap': flags.noWrap()}

    async run() {
      const {flags} = await this.parse(this.constructor as any)
      this.log(String(Boolean(flags['no-wrap'])))
    }
  }

  fancy
    .stdout()
    .it('parses --no-wrap as true', async ctx => {
      await NoWrapCommand.run(['--no-wrap'])
      expect(ctx.stdout).to.equal('true\n')
    })

  fancy
    .stdout()
    .it('defaults to falsey when omitted', async ctx => {
      await NoWrapCommand.run([])
      expect(ctx.stdout).to.equal('false\n')
    })

  it('uses the canonical no-wrap flag name', () => {
    expect(flags.noWrap().name).to.equal('no-wrap')
  })
})
