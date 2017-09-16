import { Command } from 'cli-engine-command'
import { flags } from '.'

describe('required', () => {
  class PipelineCommand extends Command {
    options = {
      flags: { pipeline: flags.pipeline({ required: true }) },
    }
    pipeline: string

    async run() {
      this.pipeline = this.flags.pipeline
    }
  }

  test('has a pipeline', async () => {
    const { cmd } = await PipelineCommand.mock<PipelineCommand>('--pipeline', 'mypipeline')
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
    options = {
      flags: { pipeline: flags.pipeline() },
    }
    pipeline?: string

    async run() {
      this.cli.log(this.flags.pipeline)
    }
  }

  test('--pipeline', async () => {
    const { stdout } = await PipelineCommand.mock('--pipeline', 'mypipeline')
    expect(stdout).toEqual('mypipeline\n')
  })

  test('-p', async () => {
    const { stdout } = await PipelineCommand.mock('-p', 'mypipeline')
    expect(stdout).toEqual('mypipeline\n')
  })

  test('is not hidden by default', async () => {
    expect(flags.pipeline().hidden).toBeFalsy()
  })

  test('does not error when pipeline is not specified', async () => {
    await PipelineCommand.mock()
  })
})
