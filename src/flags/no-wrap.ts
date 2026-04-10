import * as Flags from '@oclif/core/flags'

export function noWrap(options = {}) {
  return Flags.boolean({
    description: 'disable wrapped table cells for easier copy/paste',
    name: 'no-wrap',
    ...options,
  })
}
