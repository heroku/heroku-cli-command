import {randomUUID} from 'node:crypto'

export const requestIdHeader = 'Request-Id'

export class RequestId {
  static ids: string[] = []

  static _generate() {
    return randomUUID()
  }

  static create(): string[] {
    const tracked = RequestId.ids
    const generatedId = RequestId._generate()
    RequestId.ids = [generatedId, ...tracked]
    return RequestId.ids
  }

  static empty(): void {
    RequestId.ids = []
  }

  static track(...ids: string[]) {
    const tracked = RequestId.ids
    ids = ids.filter(id => !(tracked.includes(id)))
    RequestId.ids = [...ids, ...tracked]
    return RequestId.ids
  }

  static get headerValue() {
    return RequestId.ids.join(',')
  }
}
