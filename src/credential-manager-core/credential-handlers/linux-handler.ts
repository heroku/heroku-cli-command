import type {EventEmitter} from 'node:events'
import type {Duplex} from 'node:stream'

import {Scrubber} from '@heroku/js-blanket'
import {Message, MessageBus, sessionBus} from '@jellybrick/dbus-next'
import childProcess from 'node:child_process'

import {KeychainAuthEntry} from '../lib/types.js'

const SECRET_SERVICE_NAME = 'org.freedesktop.secrets'
const SECRET_SERVICE_PATH = '/org/freedesktop/secrets'
const SECRET_SERVICE_INTERFACE = 'org.freedesktop.Secret.Service'
const SEARCH_TIMEOUT_MS = 5000

type SecretServiceBus = Pick<MessageBus, 'call' | 'disconnect'>

interface SearchItemsReply {
  locked: string[]
  unlocked: string[]
}

interface MessageBusInternals {
  _connection?: EventEmitter & {stream?: Duplex}
}

/**
 * Handles credentials in the Linux Secret Service.
 * Uses D-Bus for metadata searches and secret-tool (libsecret) to retrieve and mutate secrets.
 */
export class LinuxHandler {
  private readonly scrubber = new Scrubber({
    patterns: [
      /\baccount\s+(?:"[^"]*"|[^\r\n]+)/g,  // Scrub account value
    ],
  })

  public constructor(private readonly createSessionBus: () => SecretServiceBus = sessionBus) {}

  /**
   * Retrieves the authentication token from the Linux keyring.
   * @param account - The account login to use (e.g. 'test@example.com')
   * @param service - The service name to use
   * @returns The stored authentication token, or undefined if no matching item exists.
   * @throws Error if searching or retrieving the token fails.
   */
  public async getAuth(account: string, service: string): Promise<string | undefined> {
    const matches = await this.searchItems(account, service)
    if (matches.unlocked.length === 0 && matches.locked.length === 0) {
      return undefined
    }

    try {
      const output = childProcess.execFileSync(
        'secret-tool',
        ['lookup', 'service', service, 'account', account],
        {encoding: 'utf8'},
      )
      const token = output.trim()

      if (!token) {
        throw new Error('Token not found')
      }

      return token
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to retrieve token from Linux keyring: ${this.scrubError(message)}`)
    }
  }

  /**
   * Lists all accounts stored in the Linux keyring for a given service.
   * @param service - The service name to search for
   * @returns Array of account names found for the service
   * @throws Error if the search operation fails
   */
  public listAccounts(service: string): string[] {
    try {
      const spawnResult = childProcess.spawnSync(
        'secret-tool',
        ['search', '--all', 'service', service],
        {encoding: 'utf8'},
      )

      if (spawnResult.error) {
        throw spawnResult.error
      }

      if (spawnResult.status !== 0) {
        const stderr = spawnResult.stderr || 'Unknown error'
        throw new Error(stderr)
      }

      /*
       * Expected output format:
       * stdout: label, secret, created, modified, schema lines
       * stderr: attribute.service / attribute.account lines
       */

      const accounts: string[] = []
      const lines = (spawnResult.stderr ?? '').split('\n')

      for (const line of lines) {
        const match = line.trim().match(/^attribute\.account\s*=\s*(.+)$/)
        if (match) {
          const account = match[1].trim()
          if (account) {
            accounts.push(account)
          }
        }
      }

      return accounts
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to list accounts in Linux keyring: ${this.scrubError(message)}`)
    }
  }

  /**
   * Removes the authentication token from the Linux keyring.
   * @param account - The account login to use (e.g. 'test@example.com')
   * @param service - The service name to use
   * @returns void
   * @throws Error if the removal operation fails.
   */
  public removeAuth(account: string, service: string): void {
    const spawnResult = childProcess.spawnSync(
      'secret-tool',
      ['clear', 'service', service, 'account', account],
      {encoding: 'utf8', env: {...process.env, LC_ALL: 'C'}},
    )

    if (spawnResult.error) {
      const {message} = spawnResult.error
      throw new Error(`Failed to remove token from Linux keyring: ${this.scrubError(message)}`)
    }

    if (spawnResult.status === 0) {
      return
    }

    const status = spawnResult.status ?? -1

    const stderr = (spawnResult.stderr ?? '').toString()
    if (this.isMissingSecretClearFailure(status, stderr)) {
      return
    }

    throw new Error(`Failed to remove token from Linux keyring: ${this.scrubError(stderr || `exit ${status}`)}`)
  }

  /**
   * Saves an authentication entry to the Linux keyring.
   * If a credential with the same attributes already exists, it is updated with the new token.
   * @param auth - The authentication entry containing account and token information to store.
   * @returns void
   * @throws Error if the save operation fails.
   */
  public saveAuth(auth: KeychainAuthEntry): void {
    try {
      const spawnResult = childProcess.spawnSync(
        'secret-tool',
        [
          'store',
          '--label=Heroku CLI',
          'service',
          auth.service,
          'account',
          auth.account,
        ],
        {
          encoding: 'utf8',
          input: auth.token,
        },
      )

      if (spawnResult.error) {
        throw spawnResult.error
      }

      if (spawnResult.status !== 0) {
        const stderr = spawnResult.stderr || 'Unknown error'
        throw new Error(stderr)
      }
    } catch (error) {
      const {message} = error as Error
      throw new Error(`Failed to store token in Linux keyring: ${this.scrubError(message)}`)
    }
  }

  /**
   * secret-tool clear fails when no matching credential exists; treat as successful no-op for logout.
   */
  private isMissingSecretClearFailure(status: number, stderr: string): boolean {
    if (status === 0) {
      return false
    }

    // secret-tool clear exits 1 with no output when nothing matched (locale-independent).
    if (status === 1 && stderr.trim() === '') {
      return true
    }

    const text = stderr.toLowerCase()
    return /no matching|could not find|not found|unknown attribute|does not exist|cannot remove/i.test(text)
  }

  private isObjectPathArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item =>
      typeof item === 'string' && (item === '/' || /^\/(?:[A-Za-z0-9_]+)(?:\/[A-Za-z0-9_]+)*$/.test(item)))
  }

  /**
   * Scrubs account names and passwords/tokens from error messages.
   *
   * @param message - The error message to scrub
   * @returns The scrubbed error message with sensitive data replaced by "[SCRUBBED]"
   */
  private scrubError(message: string): string {
    const result = this.scrubber.scrub({message})
    return result.data.message
  }

  private async searchItems(account: string, service: string): Promise<SearchItemsReply> {
    let bus: SecretServiceBus | undefined
    let timeout: NodeJS.Timeout | undefined
    let removeBusErrorListener: (() => void) | undefined
    let searchSettled = false
    let busErrorReceived = false

    try {
      bus = this.createSessionBus()
      const errorEmitter = bus as unknown as EventEmitter

      const busError = new Promise<never>((_resolve, reject) => {
        const onError = (error: Error) => {
          busErrorReceived = true
          if (!searchSettled) reject(error)
        }

        errorEmitter.on('error', onError)
        removeBusErrorListener = () => errorEmitter.removeListener('error', onError)
      })
      const message = new Message({
        body: [{account, service}],
        destination: SECRET_SERVICE_NAME,
        interface: SECRET_SERVICE_INTERFACE,
        member: 'SearchItems',
        path: SECRET_SERVICE_PATH,
        signature: 'a{ss}',
      })
      const replyPromise = bus.call(message)
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Secret Service SearchItems timed out')), SEARCH_TIMEOUT_MS)
      })
      const reply = await Promise.race([replyPromise, busError, timeoutPromise])

      if (!reply || !Array.isArray(reply.body) || reply.body.length !== 2) {
        throw new Error('Secret Service SearchItems returned an invalid response')
      }

      const [unlocked, locked] = reply.body
      if (!this.isObjectPathArray(unlocked) || !this.isObjectPathArray(locked)) {
        throw new Error('Secret Service SearchItems returned invalid item paths')
      }

      return {locked, unlocked}
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to search Linux keyring: ${this.scrubError(message)}`)
    } finally {
      searchSettled = true
      if (timeout) clearTimeout(timeout)

      if (bus) {
        const {_connection: connection} = bus as unknown as MessageBusInternals
        let stream = connection?.stream
        let cleaned = false

        const cleanup = () => {
          if (cleaned) return
          cleaned = true
          stream?.removeListener('close', cleanup)
          connection?.removeListener('connect', onConnect)
          connection?.removeListener('error', onConnectionError)
          connection?.removeListener('end', onConnectionEnd)
          removeBusErrorListener?.()
          removeBusErrorListener = undefined
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
            bus?.disconnect()
          } catch {
            // Disconnect errors must not mask the search result or cause an unhandled bus error.
          }

          closeStream()
        }

        const onConnectionError = () => {
          // Destroy a stream that failed before connect, or clean up if setup never opened one.
          closeStream()
        }

        const onConnectionEnd = () => {
          // With a stream, wait for close: errors may still be emitted between end and close.
          closeStream()
        }

        if (stream) {
          stream.once('close', cleanup)
        } else if (connection) {
          // A connection may still be opening when the search times out. Close it if it connects later.
          connection.once('connect', onConnect)
          connection.once('error', onConnectionError)
          connection.once('end', onConnectionEnd)
        }

        try {
          bus.disconnect()
        } catch {
          // Disconnect errors must not mask the search result or cause an unhandled bus error.
        }

        if (stream) {
          // MessageBus.disconnect() only calls stream.end(); destroy it so a timed-out call
          // cannot leave a half-open socket behind. Keep the error listener until close.
          closeStream()
        } else if (!connection || busErrorReceived) {
          cleanup()
        }
      }
    }
  }
}
