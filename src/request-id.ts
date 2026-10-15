import {randomUUID} from 'node:crypto'

export const requestIdHeader = 'Request-Id'

/* eslint-disable unicorn/class-reference-in-static-methods -- RequestId is exported public API; `this` would change behavior for detached methods (TypeError) and subclasses (per-subclass `ids` instead of the shared store), so reference the class explicitly as it always has */

// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- RequestId is an exported static-class public API (RequestId.create()/track()/etc.); converting to free functions would be a breaking change
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
/* eslint-enable unicorn/class-reference-in-static-methods */
