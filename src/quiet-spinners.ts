import {ux} from '@oclif/core/ux'

const METHODS = ['pause', 'pauseAsync', 'start', 'stop'] as const

let depth = 0
/** Own properties replaced on `ux.action`, so restoring puts back exactly what was there. */
let replaced: Array<[string, PropertyDescriptor | undefined]> | undefined

/**
 * Makes `ux.action` silent: `start`, `stop` and status updates write nothing and
 * don't take over `process.stdout`/`process.stderr`, and `pause` just runs its
 * callback. A spinner already running is stopped first. oclif has no quiet
 * mode for `ux.action`, so this replaces the methods on the shared instance.
 * Calls nest (a command run from another command); the returned function
 * restores the spinner once every caller has restored. Each restore function
 * only counts once.
 */
export function quietSpinners(): () => void {
  if (depth === 0) {
    const {action} = ux
    // A spinner started earlier (a prerun hook, a parent command) is capturing stdout, and the
    // no-op stop below couldn't release it, so the JSON document would land in its buffer.
    if (action.running) action.stop()
    replaced = METHODS.map(name => [name, Object.getOwnPropertyDescriptor(action, name)])
    action.start = () => {}
    action.stop = () => {}
    action.pause = async fn => fn()
    action.pauseAsync = async fn => fn()
    // The status setter and `running` read the task, which `start` no longer sets.
  }

  depth++
  let restored = false
  return () => {
    if (restored) return
    restored = true
    depth--
    if (depth === 0 && replaced) {
      for (const [name, descriptor] of replaced) {
        if (descriptor) Object.defineProperty(ux.action, name, descriptor)
        else Reflect.deleteProperty(ux.action, name)
      }

      replaced = undefined
    }
  }
}
