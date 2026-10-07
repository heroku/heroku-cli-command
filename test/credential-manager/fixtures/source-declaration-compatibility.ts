import type {AuthEntry as CoreAuthEntry} from '../../../src/credential-manager-core/index.js'
import type {AuthEntry as TypesAuthEntry} from '../../../src/credential-manager-core/lib/types.js'
import type {AuthEntry as FacadeAuthEntry} from '../../../src/credential-manager.js'
import type {AuthEntry as RootAuthEntry} from '../../../src/index.js'

type Assert<T extends true> = T
type HistoricalAuthEntry = {
  account: string | undefined;
  token: string | undefined;
}
type IsEqual<Left, Right> = (
  <T>() => T extends Left ? 1 : 2
) extends (<T>() => T extends Right ? 1 : 2) ? true : false

const historicalAuthEntry = {
  account: undefined,
  token: undefined,
}

const coreAuthEntry: CoreAuthEntry = historicalAuthEntry
const facadeAuthEntry: FacadeAuthEntry = historicalAuthEntry
const rootAuthEntry: RootAuthEntry = historicalAuthEntry
const typesAuthEntry: TypesAuthEntry = historicalAuthEntry

type HistoricalAuthEntryDeclarationsRemainCompatible = [
  Assert<IsEqual<CoreAuthEntry, HistoricalAuthEntry>>,
  Assert<IsEqual<FacadeAuthEntry, HistoricalAuthEntry>>,
  Assert<IsEqual<RootAuthEntry, HistoricalAuthEntry>>,
  Assert<IsEqual<TypesAuthEntry, HistoricalAuthEntry>>,
]

export {
  coreAuthEntry,
  facadeAuthEntry,
  type HistoricalAuthEntryDeclarationsRemainCompatible,
  rootAuthEntry,
  typesAuthEntry,
}
