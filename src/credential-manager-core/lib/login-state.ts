/** @deprecated Import login-state APIs from `@heroku/heroku-credential-manager`. */
/* eslint-disable n/no-extraneous-import */
import {createHash} from 'node:crypto'
import {join, resolve} from 'node:path'

export {
  deleteLoginState,
  readLoginState,
  writeLoginState,
} from '@heroku/heroku-credential-manager'
/* eslint-enable n/no-extraneous-import */

const DEFAULT_API_HOST = 'api.heroku.com'
const DEFAULT_CREDENTIAL_SERVICE = 'heroku-cli'
const lifecycleQueues = new Map<string, {pending: number; tail: Promise<void>}>()

/** Serializes credential and login-state mutations for one persistent storage scope. */
export async function synchronizeLoginLifecycle<T>(
  dataDir: string | undefined,
  credentialService: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = `${dataDir ? resolve(dataDir) : ''}\0${credentialService}`
  const queue = lifecycleQueues.get(key) ?? {pending: 0, tail: Promise.resolve()}
  queue.pending++
  const previous = queue.tail
  let release!: () => void
  queue.tail = new Promise<void>(resolveTail => {
    release = resolveTail
  })
  lifecycleQueues.set(key, queue)

  await previous
  try {
    return await task()
  } finally {
    release()
    queue.pending--
    if (queue.pending === 0 && lifecycleQueues.get(key) === queue) lifecycleQueues.delete(key)
  }
}

/**
 * Keeps production on its historical login.json while isolating custom native
 * account selection by the exact API host and credential service.
 */
export function loginStateDataDir(dataDir: string, apiHost: string, credentialService: string): string {
  if (apiHost === DEFAULT_API_HOST && credentialService === DEFAULT_CREDENTIAL_SERVICE) return dataDir

  const scope = createHash('sha256')
    .update(credentialService)
    .update('\0')
    .update(apiHost)
    .digest('hex')
  return join(dataDir, 'login-state', scope)
}
