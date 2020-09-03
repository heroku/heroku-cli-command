import {v4 as uuid} from 'uuid'

// tslint:disable-next-line: no-unnecessary-class
export class RequestId {
  private static _id: string

  static get id() {
    if (!RequestId._id) {
      RequestId._id = uuid()
    }

    return RequestId._id
  }
}
