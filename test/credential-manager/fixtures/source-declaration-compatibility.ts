import type {
  AuthEntry as CoreAuthEntry,
  CredentialStore as CoreCredentialStore,
  KeychainAuthEntry as CoreKeychainAuthEntry,
  Machines as CoreMachines,
  MachinesWithTokens as CoreMachinesWithTokens,
  MachineToken as CoreMachineToken,
  NetrcAuthEntry as CoreNetrcAuthEntry,
  StorageConfig as CoreStorageConfig,
  Token as CoreToken,
} from '../../../src/credential-manager-core/index.js'
import type {
  AuthEntry as TypesAuthEntry,
  KeychainAuthEntry as TypesKeychainAuthEntry,
  NetrcAuthEntry as TypesNetrcAuthEntry,
} from '../../../src/credential-manager-core/lib/types.js'
import type {AuthEntry as FacadeAuthEntry} from '../../../src/credential-manager.js'
import type {
  AuthEntry as CommandRootAuthEntry,
  CredentialStore as CommandRootCredentialStore,
  KeychainAuthEntry as CommandRootKeychainAuthEntry,
  Machines as CommandRootMachines,
  MachinesWithTokens as CommandRootMachinesWithTokens,
  MachineToken as CommandRootMachineToken,
  NetrcAuthEntry as CommandRootNetrcAuthEntry,
  StorageConfig as CommandRootStorageConfig,
  Token as CommandRootToken,
} from '../../../src/index.js'

import {LOCALHOST_DOMAINS as ApiClientLocalhostDomains} from '../../../src/api-client.js'
import {LOCALHOST_DOMAINS as CommandRootLocalhostDomains} from '../../../src/index.js'

const historicalAuthEntry = {
  account: undefined,
  token: undefined,
}

const commandRootAuthEntry: CommandRootAuthEntry = historicalAuthEntry
const coreAuthEntry: CoreAuthEntry = historicalAuthEntry
const typesAuthEntry: TypesAuthEntry = historicalAuthEntry
const facadeAuthEntry: FacadeAuthEntry = historicalAuthEntry

type Assert<T extends true> = T
type HistoricalAuthEntry = {
  account: string | undefined
  token: string | undefined
}
type IsAssignable<From, To> = From extends To ? true : false
type IsEqual<Left, Right> = (
  <T>() => T extends Left ? 1 : 2
) extends (<T>() => T extends Right ? 1 : 2) ? true : false

type HistoricalTypesRemainCompatible = [
  Assert<IsEqual<CommandRootAuthEntry, HistoricalAuthEntry>>,
  Assert<IsEqual<CoreAuthEntry, HistoricalAuthEntry>>,
  Assert<IsEqual<TypesAuthEntry, HistoricalAuthEntry>>,
  Assert<IsEqual<FacadeAuthEntry, HistoricalAuthEntry>>,
  Assert<IsAssignable<CommandRootCredentialStore, CoreCredentialStore>>,
  Assert<IsAssignable<CommandRootKeychainAuthEntry, CoreKeychainAuthEntry>>,
  Assert<IsAssignable<CommandRootMachineToken, CoreMachineToken>>,
  Assert<IsAssignable<CommandRootMachines, CoreMachines>>,
  Assert<IsAssignable<CommandRootMachinesWithTokens, CoreMachinesWithTokens>>,
  Assert<IsAssignable<CommandRootNetrcAuthEntry, CoreNetrcAuthEntry>>,
  Assert<IsAssignable<CommandRootStorageConfig, CoreStorageConfig>>,
  Assert<IsAssignable<CommandRootToken, CoreToken>>,
  Assert<IsAssignable<TypesKeychainAuthEntry, CoreKeychainAuthEntry>>,
  Assert<IsAssignable<TypesNetrcAuthEntry, CoreNetrcAuthEntry>>,
]

const localhostDomains: readonly string[] = ApiClientLocalhostDomains
const rootLocalhostDomains: readonly string[] = CommandRootLocalhostDomains

export {
  commandRootAuthEntry,
  coreAuthEntry,
  facadeAuthEntry,
  type HistoricalTypesRemainCompatible,
  localhostDomains,
  rootLocalhostDomains,
  typesAuthEntry,
}
