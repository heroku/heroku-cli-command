/* eslint-disable n/no-extraneous-import */
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
/* eslint-enable n/no-extraneous-import */

/** @deprecated Import and instantiate `Netrc` from `@heroku/heroku-credential-manager`. */
export default new Netrc()
