// @flow

import Command from 'cli-engine-command'
import PipelineFlag from './pipeline'

describe('required', () => {
  class PipelineCommand extends Command<*> {
    static flags = {pipeline: PipelineFlag({required: true})}
    pipeline: string

    async run () {
      this.pipeline = this.flags.pipeline
    }
  }

  test('has a pipeline', async () => {
    const cmd = await PipelineCommand.mock('--pipeline', 'mypipeline')
    expect(cmd.pipeline).toEqual('mypipeline')
  })

  test('errors with no pipeline', async () => {
    const cmd = await PipelineCommand.mock()
    expect(cmd.err).toHaveProperty('message', 'Missing required flag --pipeline')
  })
})

describe('optional', () => {
  class PipelineCommand extends Command<*> {
    static flags = {pipeline: PipelineFlag()}
    pipeline: ?string

    async run () {
      this.pipeline = this.flags.pipeline
    }
  }

  test('--pipeline', async () => {
    const cmd = await PipelineCommand.mock('--pipeline', 'mypipeline')
    expect(cmd.pipeline).toEqual('mypipeline')
  })

  test('-p', async () => {
    const cmd = await PipelineCommand.mock('-p', 'mypipeline')
    expect(cmd.pipeline).toEqual('mypipeline')
  })

  test('is not hidden by default', async () => {
    expect(PipelineCommand.flags.pipeline.hidden).toBeFalsy()
  })

  test('does not error when pipeline is not specified', async () => {
    await PipelineCommand.mock()
  })
})
