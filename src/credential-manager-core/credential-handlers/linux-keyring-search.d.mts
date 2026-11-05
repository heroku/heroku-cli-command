import type {Message} from '@jellybrick/dbus-next'
import type {EventEmitter} from 'node:events'

export interface SearchBus extends EventEmitter {
  call(message: Message): Promise<unknown>
  disconnect(): void
}

export type SearchResult = 'locked-match' | 'match' | 'no-match'

export function searchKeyring(
  account: string,
  service: string,
  createSessionBus?: () => SearchBus,
): Promise<SearchResult>
