import debug from 'debug'

import {Netrc} from '../lib/netrc-parser.js'
import {NetrcAuthEntry} from '../lib/types.js'

const credDebug = debug('heroku-credential-manager')

export class NetrcHandler {
  public readonly netrc: Netrc

  /** @param file - Optional netrc path; otherwise uses the default location. */
  constructor(file?: string) {
    this.netrc = new Netrc(file)
  }

  /**
   * Retrieves authentication credentials for a given host.
   * @param host - The hostname to retrieve credentials for.
   * @returns The authentication entry for the host, or undefined if not found.
   */
  public async getAuth(host: string) {
    await this.netrc.load()
    const auth = this.netrc.machines[host]
    if (!auth) {
      throw new Error(`No auth found for ${host}`)
    }

    return auth
  }

  /**
   * Removes authentication credentials for a given host.
   * @param host - The hostname to remove credentials for.
   * @returns A promise that resolves when the credentials are removed.
   */
  public async removeAuth(host: string) {
    await this.removeAuthForHosts([host])
  }

  /**
   * Removes credentials for multiple hosts with a single netrc load/save.
   */
  public async removeAuthForHosts(hosts: string[]) {
    if (hosts.length === 0) return
    await this.netrc.load()
    let changed = false
    for (const host of hosts) {
      if (!this.netrc.machines[host]) {
        credDebug(`No credentials to logout for ${host}`)
        continue
      }

      delete this.netrc.machines[host]
      changed = true
    }

    if (changed) await this.netrc.save()
  }

  /**
   * Saves authentication credentials for a given host.
   * @param auth - The authentication entry containing login and password.
   * @param host - The hostname to save credentials for.
   * @returns A promise that resolves when the credentials are saved.
   */
  public async saveAuth(auth: NetrcAuthEntry, host: string) {
    await this.saveAuthForHosts(auth, [host])
  }

  /**
   * Saves the same credentials for multiple hosts with a single netrc load/save.
   */
  public async saveAuthForHosts(auth: NetrcAuthEntry, hosts: string[]) {
    if (hosts.length === 0) return
    await this.netrc.load()
    for (const host of hosts) {
      this.applyAuthToHost(auth, host)
    }

    await this.netrc.save()
  }

  private applyAuthToHost(auth: NetrcAuthEntry, host: string) {
    if (!this.netrc.machines[host]) this.netrc.machines[host] = {}
    this.netrc.machines[host] = {
      login: auth.login,
      password: auth.password,
    }
    delete this.netrc.machines[host].method
    delete this.netrc.machines[host].org

    if (this.netrc.machines._tokens) {
      for (const token of this.netrc.machines._tokens) {
        if (token.type === 'machine' && host === token.host) {
          token.internalWhitespace = '\n  '
        }
      }
    }
  }
}
