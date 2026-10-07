import {access} from 'node:fs/promises'
import {join, resolve} from 'node:path'

import {
  deleteLoginState,
  readLoginState,
  writeLoginState,
} from './credential-manager-core/lib/login-state.js'

type LoginState = Awaited<ReturnType<typeof readLoginState>>

type Queue = {
  pending: number;
  tail: Promise<void>;
}

export type LoginStateRevision = {
  dataDir: string;
  revision: number;
}

const queues = new Map<string, Queue>()
// A CLI process uses few configured data directories. Keeping their monotonic
// revisions for the process lifetime prevents an idle queue from recycling a
// stale revision while keeping the map naturally bounded in normal CLI use.
const revisions = new Map<string, number>()

function normalizedDataDir(dataDir: string): string {
  return resolve(dataDir)
}

async function loginStateExists(dataDir: string): Promise<boolean | undefined> {
  try {
    await access(join(dataDir, 'login.json'))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
  }
}

async function deleteWithRevision(dataDir: string, revision: number): Promise<boolean> {
  const existed = await loginStateExists(dataDir)
  await deleteLoginState(dataDir)
  const stillExists = await loginStateExists(dataDir)
  if (existed !== true || stillExists !== false) return false

  revisions.set(dataDir, revision + 1)
  return true
}

async function coordinate<T>(dataDir: string, operation: (normalizedDataDir: string) => Promise<T>): Promise<T> {
  const key = normalizedDataDir(dataDir)
  const queue = queues.get(key) ?? {pending: 0, tail: Promise.resolve()}
  queues.set(key, queue)
  queue.pending++

  const result = queue.tail.then(async () => operation(key), async () => operation(key))
  queue.tail = result.then(() => {}, () => {})
  return result.finally(() => {
    queue.pending--
    if (queue.pending === 0 && queues.get(key) === queue) queues.delete(key)
  })
}

// This coordinator guarantees FIFO ordering only among cooperating operations
// in this process that use the same normalized configured dataDir. It does not
// provide cross-process locking or defend against hostile filesystem mutation.
export async function withLoginStateCoordination<T>(
  dataDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  return coordinate(dataDir, operation)
}

export async function writeLoginStateCoordinated(dataDir: string, account: string): Promise<void> {
  return coordinate(dataDir, async normalized => {
    await writeLoginState(normalized, account)
    revisions.set(normalized, (revisions.get(normalized) ?? 0) + 1)
  })
}

export async function deleteLoginStateCoordinated(dataDir: string): Promise<void> {
  return coordinate(dataDir, async normalized => {
    await deleteWithRevision(normalized, revisions.get(normalized) ?? 0)
  })
}

export async function getLoginStateRevision(dataDir: string): Promise<LoginStateRevision> {
  return coordinate(dataDir, async normalized => ({
    dataDir: normalized,
    revision: revisions.get(normalized) ?? 0,
  }))
}

export async function deleteLoginStateIf(
  dataDir: string,
  expectedRevision: LoginStateRevision,
  predicate: (state: LoginState) => boolean,
): Promise<boolean> {
  return coordinate(dataDir, async normalized => {
    const revision = revisions.get(normalized) ?? 0
    if (normalized !== expectedRevision.dataDir || revision !== expectedRevision.revision) return false

    const state = await readLoginState(normalized)
    if (!predicate(state)) return false

    return deleteWithRevision(normalized, revision)
  })
}
