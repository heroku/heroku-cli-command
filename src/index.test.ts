import { Command, flags } from '.'

test('has flags', async () => {
  expect(flags).toBeTruthy()
  expect(typeof flags.team).toEqual('function')
  expect(typeof flags.org).toEqual('function')
})

test('has Command', async () => {
  expect(typeof Command).toEqual('function')
})
