import {randomUUID} from 'node:crypto'

export const requestIdHeader = 'Request-Id'

export class RequestId {
  static ids: string[] = []

  static _generate() {
    return randomUUID()
  }

  static create(): string[] {
    const tracked = this.ids
    const generatedId = this._generate()
    this.ids = [generatedId, ...tracked]
    return this.ids
  }

  static empty(): void {
    this.ids = []
  }

  static track(...ids: string[]) {
    const tracked = this.ids
    ids = ids.filter(id => !(tracked.includes(id)))
    this.ids = [...ids, ...tracked]
    return this.ids
  }

  static get headerValue() {
    return this.ids.join(',')
  }
}
