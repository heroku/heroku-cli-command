import {v4 as uuid} from 'uuid'

let requestId: string

// `requestId` is generated once per entire node session
// upon the first call of `getRequestId`
export function getRequestId(): string {
  if (!requestId) {
    requestId = uuid()
  }

  return requestId
}
