import { Command } from 'cli-engine-command'
import * as flags from './pipeline'

describe('required', () => {
  class PipelineCommand extends Command {
    static flags = { pipeline: flags.pipeline({ required: true }) }
    pipeline: string

    async run() {
      this.pipeline = this.flags.pipeline
    }
  }

  test('has a pipeline', async () => {
    const { cmd } = await PipelineCommand.mock(['--pipeline', 'mypipeline'])
    expect(cmd.pipeline).toEqual('mypipeline')
  })

  test('errors with no pipeline', async () => {
    expect.assertions(1)
    try {
      await PipelineCommand.mock()
    } catch (err) {
      expect(err.message).toContain('Missing required flag:\n -p, --pipeline PIPELINE')
    }
  })
})

describe('optional', () => {
  class PipelineCommand extends Command {
    static flags = { pipeline: flags.pipeline() }
    pipeline?: string

    async run() {
      this.pipeline = this.flags.pipeline
    }
  }

  test('--pipeline', async () => {
    const { cmd } = await PipelineCommand.mock(['--pipeline', 'mypipeline'])
    expect(cmd.pipeline).toEqual('mypipeline')
  })

  test('-p', async () => {
    const { cmd } = await PipelineCommand.mock(['-p', 'mypipeline'])
    expect(cmd.pipeline).toEqual('mypipeline')
  })

  test('is not hidden by default', async () => {
    expect(flags.pipeline().hidden).toBeFalsy()
  })

  test('does not error when pipeline is not specified', async () => {
    await PipelineCommand.mock()
  })
})
