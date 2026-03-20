/**
 * Thin wrapper around @heroku/heroku-credential-manager so tests can inject a mock
 * (ESM module exports cannot be stubbed with sinon).
 */
import {
  getAuth as realGetAuth,
  removeAuth as realRemoveAuth,
  saveAuth as realSaveAuth,
} from '@heroku/heroku-credential-manager'

export interface CredentialManagerProvider {
  getAuth: (account: string | undefined, host: string, service?: string) => Promise<string>
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
): Promise<string> {
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
