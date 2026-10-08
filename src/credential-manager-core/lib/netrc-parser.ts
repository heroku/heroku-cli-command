
import {Netrc} from '@heroku/heroku-credential-manager'

/** @deprecated Import netrc parser APIs from `@heroku/heroku-credential-manager`. */
export {
  Netrc,
  parse,
} from '@heroku/heroku-credential-manager'

/** @deprecated Import netrc parser types from `@heroku/heroku-credential-manager`. */
export type {
  Machines,
  MachinesWithTokens,
  MachineToken,
  Token,
} from '@heroku/heroku-credential-manager'

/** @deprecated Import and instantiate `Netrc` from `@heroku/heroku-credential-manager`. */
const defaultNetrc = new Netrc()
export default defaultNetrc
