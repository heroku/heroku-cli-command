// @flow

import Command from 'cli-engine-command'
import PipelineFlag from './pipeline'

it('has a short form of "p"', () => {
  const pflag: PipelineFlag = new PipelineFlag()
  expect(pflag.char).toBe('p')
})

it('is not hidden', () => {
  const pflag: PipelineFlag = new PipelineFlag()
  expect(pflag.hidden).toBeFalsy()
})

it('returns the input when it is given', () => {
  const pflag: PipelineFlag = new PipelineFlag()
  expect(pflag.parse('input', {some: 'command'})).toEqual('input')
})

it('throws an error when it is required but not given', () => {
  const pflag: PipelineFlag = new PipelineFlag({required: true})
  let thrown = false
  try {
    pflag.parse(undefined, {some: 'command'})
  } catch (e) {
    thrown = true
    expect(e.message).toEqual('No pipeline specified')
  }
  expect(thrown).toEqual(true)
})

describe('required', () => {
  class PipelineCommand extends Command {
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
    expect.assertions(1)
    try {
      await PipelineCommand.mock()
    } catch (err) {
      expect(err.message).toContain('No pipeline specified')
    }
  })
})

describe('optional', () => {
  class PipelineCommand extends Command {
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
