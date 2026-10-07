/**
 * Thin wrapper around the credential manager so tests can inject a mock
 * (ESM module exports cannot be stubbed with sinon).
 */

import {
  getAuth as realGetAuth,
  removeAuth as realRemoveAuth,
  saveAuth as realSaveAuth,
} from './credential-manager-core/lib/credential-manager-adapter.js'

/** Backward-compatible shape used by command consumers before storage extraction. */
export type AuthEntry = {
  account: string | undefined;
  token: string | undefined;
}

export interface CredentialManagerProvider {
  getAuth: (account: string | undefined, host: string, service?: string) => Promise<AuthEntry>;
  removeAuth: (account: string | undefined, hosts: string[], service?: string, expectedToken?: string) => Promise<void>;
  saveAuth: (account: string, token: string, hosts: string[], service?: string) => Promise<void>;
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
  expectedToken?: string,
): Promise<void> {
  return provider.removeAuth(account, hosts, service, expectedToken)
}

export async function saveAuth(
  account: string,
  token: string,
  hosts: string[],
  service?: string,
): Promise<void> {
  return provider.saveAuth(account, token, hosts, service)
}
