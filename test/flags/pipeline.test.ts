import {Command} from '@oclif/core'
import {expect, fancy} from 'fancy-test'

import * as flags from '../../src/flags'

describe('required', () => {
  class PipelineCommand extends Command {
    static flags = {pipeline: flags.pipeline({required: true})}

    async run() {
      const {flags} = await this.parse(this.constructor as any)
      this.log(flags.pipeline)
    }
  }

  fancy
    .stdout()
    .it('has a pipeline', async ctx => {
      await PipelineCommand.run(['--pipeline', 'mypipeline'])
      expect(ctx.stdout).to.equal('mypipeline\n')
    })

  fancy
    .stdout()
    .it('errors with no pipeline', async (_, done) => {
      try {
        await PipelineCommand.run([])
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).to.contain('Missing required flag pipeline')
        } else {
          throw new TypeError('Unexpected error')
        }

        done()
      }
    })
})

describe('optional', () => {
  class PipelineCommand extends Command {
    static flags = {pipeline: flags.pipeline()}
    pipeline?: string

    async run() {
      const {flags} = await this.parse(this.constructor as any)
      this.log(flags.pipeline)
    }
  }

  fancy
    .stdout()
    .it('--pipeline', async ctx => {
      await PipelineCommand.run(['--pipeline', 'mypipeline'])
      expect(ctx.stdout).to.equal('mypipeline\n')
    })

  fancy
    .stdout()
    .it('-p', async ctx => {
      await PipelineCommand.run(['-p', 'mypipeline'])
      expect(ctx.stdout).to.equal('mypipeline\n')
    })

  fancy
    .stdout()
    .it('is not hidden by default', async () => {
      expect(flags.pipeline().hidden).to.not.be.ok
    })

  fancy
    .stdout()
    .it('does not error when pipeline is not specified', async () => {
      await PipelineCommand.run([])
    })
})
