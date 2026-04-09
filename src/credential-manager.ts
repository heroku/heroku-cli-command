/**
 * Thin wrapper around credential-manager-core so tests can inject a mock
 * (ESM module exports cannot be stubbed with sinon).
 */
import {
  getAuth as realGetAuth,
  removeAuth as realRemoveAuth,
  saveAuth as realSaveAuth,
  type AuthEntry,
} from './credential-manager-core/index.js'

export interface CredentialManagerProvider {
  getAuth: (account: string | undefined, host: string, service?: string) => Promise<AuthEntry>
  removeAuth: (account: string | undefined, hosts: string[], service?: string) => Promise<void>
  saveAuth: (account: string, token: string, hosts: string[], service?: string) => Promise<void>
}

let provider: CredentialManagerProvider = {
  getAuth: realGetAuth,
  removeAuth: realRemoveAuth,
  saveAuth: realSaveAuth,
}

export function setCredentialManagerProvider(p: CredentialManagerProvider): void {
  provider = p
}

export async function getAuth(
  account: string | undefined,
  host: string,
  service?: string,
): Promise<AuthEntry> {
  return provider.getAuth(account, host, service)
}

export async function removeAuth(
  account: string | undefined,
  hosts: string[],
  service?: string,
): Promise<void> {
  return provider.removeAuth(account, hosts, service)
}

export async function saveAuth(
  account: string,
  token: string,
  hosts: string[],
  service?: string,
): Promise<void> {
  return provider.saveAuth(account, token, hosts, service)
}

export type {AuthEntry} from './credential-manager-core/index.js'
