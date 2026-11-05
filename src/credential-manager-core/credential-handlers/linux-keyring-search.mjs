import {Message, sessionBus} from '@jellybrick/dbus-next'
import {pathToFileURL} from 'node:url'

const SECRET_SERVICE_NAME = 'org.freedesktop.secrets'
const SECRET_SERVICE_PATH = '/org/freedesktop/secrets'
const SECRET_SERVICE_INTERFACE = 'org.freedesktop.Secret.Service'
const SEARCH_TIMEOUT_MS = 4000

function isObjectPathArray(value) {
  if (!Array.isArray(value)) return false

  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false

    const item = value[index]
    if (typeof item !== 'string' || !(item === '/' || /^\/(?:[A-Za-z0-9_]+)(?:\/[A-Za-z0-9_]+)*$/.test(item))) return false
  }

  return true
}

export async function searchKeyring(account, service, createSessionBus = sessionBus) {
  const bus = createSessionBus()
  let timeout
  let searchSettled = false
  let onBusError

  try {
    const busError = new Promise((_resolve, reject) => {
      onBusError = () => {
        if (!searchSettled) reject(new Error('SearchItems failed'))
      }

      bus.on('error', onBusError)
    })
    const replyPromise = bus.call(new Message({
      body: [{account, service}],
      destination: SECRET_SERVICE_NAME,
      interface: SECRET_SERVICE_INTERFACE,
      member: 'SearchItems',
      path: SECRET_SERVICE_PATH,
      signature: 'a{ss}',
    }))
    const timeoutPromise = new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('SearchItems timed out')), SEARCH_TIMEOUT_MS)
    })
    const reply = await Promise.race([replyPromise, busError, timeoutPromise])

    if (!reply || !Array.isArray(reply.body) || reply.body.length !== 2) {
      throw new Error('Invalid SearchItems response')
    }

    const [unlocked, locked] = reply.body
    if (!isObjectPathArray(unlocked) || !isObjectPathArray(locked)) {
      throw new Error('Invalid SearchItems item paths')
    }

    if (locked.length > 0) return 'locked-match'
    if (unlocked.length > 0) return 'match'
    return 'no-match'
  } finally {
    searchSettled = true
    if (timeout) clearTimeout(timeout)

    // MessageBus does not forward the internal connection's `end` event. Keep this listener attached
    // as a no-op after settlement so later `error` events remain handled until the bus is collected.
    // The default helper creates a short-lived bus, so retaining it here does not extend its lifetime.

    try {
      bus.disconnect()
    } catch {
      // Disconnect failures must not change the strict protocol result.
    }
  }
}

async function readInput() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const request = JSON.parse(input)
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).length !== 2
    || typeof request.account !== 'string'
    || typeof request.service !== 'string') {
    throw new Error('Invalid request')
  }

  return request
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const {account, service} = await readInput()
    const status = await searchKeyring(account, service)
    process.stdout.write(JSON.stringify({status}), error => process.exit(error ? 1 : 0))
  } catch {
    process.exit(1)
  }
}
