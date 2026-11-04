import {Message, sessionBus} from '@jellybrick/dbus-next'
import {pathToFileURL} from 'node:url'

const SECRET_SERVICE_NAME = 'org.freedesktop.secrets'
const SECRET_SERVICE_PATH = '/org/freedesktop/secrets'
const SECRET_SERVICE_INTERFACE = 'org.freedesktop.Secret.Service'
const SEARCH_TIMEOUT_MS = 4000

function isObjectPathArray(value) {
  return Array.isArray(value) && value.every(item =>
    typeof item === 'string' && (item === '/' || /^\/(?:[A-Za-z0-9_]+)(?:\/[A-Za-z0-9_]+)*$/.test(item)))
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

    const connection = bus._connection
    let stream = connection?.stream
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      stream?.removeListener('close', cleanup)
      connection?.removeListener('connect', onConnect)
      connection?.removeListener('error', onConnectionError)
      connection?.removeListener('end', onConnectionEnd)
      if (onBusError) bus.removeListener('error', onBusError)
    }

    const closeStream = () => {
      stream = connection?.stream
      if (!stream) {
        cleanup()
        return
      }

      stream.once('close', cleanup)
      try {
        stream.destroy()
      } catch {
        cleanup()
      }
    }

    const onConnect = () => {
      try {
        bus.disconnect()
      } catch {
        // Disconnect errors must not obscure the search result.
      }

      closeStream()
    }

    const onConnectionError = () => closeStream()
    const onConnectionEnd = () => closeStream()

    // Keep the search listener until the socket closes to catch late connection errors.
    if (stream) {
      stream.once('close', cleanup)
    } else if (connection) {
      connection.once('connect', onConnect)
      connection.once('error', onConnectionError)
      connection.once('end', onConnectionEnd)
    }

    try {
      bus.disconnect()
    } catch {
      // Disconnect failures must not change the strict protocol result.
    }

    if (stream) {
      closeStream()
    } else if (!connection) {
      cleanup()
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
    process.stdout.write(JSON.stringify({status}))
  } catch {
    process.exitCode = 1
  }
}
