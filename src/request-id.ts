import * as uuid from 'uuid'

export const requestIdHeader = 'Request-Id'

// tslint:disable-next-line: no-unnecessary-class
export class RequestId {
  static ids: string[] = []

  static track(...ids: string[]) {
    const tracked = RequestId.ids
    RequestId.ids = [...ids, ...tracked]
    return RequestId.ids
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

  static get headerValue() {
    return RequestId.ids.join(',')
  }

  static _generate() {
    return uuid.v4()
  }
}
