import type {
  LoginOptions as CredentialManagerLoginOptions,
  LoginPromptSelection,
  LoginResult,
  LoginStorage,
} from '@heroku/heroku-credential-manager/login'
import type {HTTP} from '@heroku/http-call'
import type {Config} from '@oclif/core/interfaces'
import type {ChildProcess} from 'node:child_process'

import {
  Login as CredentialManagerLogin,
  LoginCancelledError,
  LoginRequestError,
} from '@heroku/heroku-credential-manager/login'
import {HTTPError} from '@heroku/http-call'
import {ux} from '@oclif/core/ux'
import {greenBright, yellow} from 'ansis'
import os from 'node:os'
import * as readline from 'node:readline'

import {type APIClient, HerokuAPIError, type IHerokuAPIErrorOptions} from './api-client.js'
import {getStorageConfig} from './credential-manager-core/lib/credential-storage-selector.js'
import {
  readLoginState,
} from './credential-manager-core/lib/login-state.js'
import {
  createCredentialManagerFetchAdapter,
  createCredentialManagerPlatformAdapter,
} from './credential-manager-login-adapters.js'
import {getAuth, removeAuth, saveAuth} from './credential-manager.js'
import {
  deleteLoginStateCoordinated,
  writeLoginStateCoordinated,
} from './login-state-coordinator.js'
import {prompter} from './prompter.js'
import {vars} from './vars.js'

const LOGIN_TIMEOUT = 10 * 60 * 1000
const REQUEST_TIMEOUT = 60 * 1000

// Stamped on the error thrown when an interactive login is required but stdin
// is not a TTY. Exported so consumers can recognize this condition by code
// rather than matching a string literal.
export const NONINTERACTIVE_LOGIN_ERROR_CODE = 'HEROKU_NONINTERACTIVE_LOGIN'

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Login {
  export type Method = 'b' | 'browser' | 'i' | 'interactive' | 's' | 'sso'

  export type Options = {
    browser?: string;
    expiresIn?: number;
    method?: Method;
  }
}

type PromptOperation = {
  cancel?: (reason: unknown) => void;
  completion?: Promise<void>;
}

type PromptValueOptions = {
  defaultValue?: string;
  message: string;
  name: 'email' | 'orgName' | 'password' | 'secondFactor';
  type: 'input' | 'password';
}

export class Login {
  loginHost = process.env.HEROKU_LOGIN_HOST || 'https://cli-auth.heroku.com'
  private lifecycle = Promise.resolve()

  constructor(private readonly config: Config, private readonly heroku: APIClient) {}

  async login(opts: Login.Options = {}): Promise<void> {
    return this.serialize(() => this.loginUnlocked(opts))
  }

  /**
   * Revokes a token without touching persistent credentials. This preserves the
   * historical token-only API used for account-less environment credentials.
   */
  async logout(token?: string): Promise<void> {
    return this.serialize(async () => {
      const resolvedToken = token ?? await this.heroku.getAuth()
      if (!resolvedToken) return

      try {
        await this.createDelegate(true).logout({account: 'remote-only', token: resolvedToken})
      } catch (error) {
        throw this.mapLoginFailure(error)
      }
    })
  }

  /**
   * Revokes and removes a complete credential entry. The package owns all
   * persistent credential and login-state cleanup for this operation.
   */
  async logoutEntry(entry: LoginResult): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.createDelegate().logout(entry)
      } catch (error) {
        throw this.mapLoginFailure(error)
      }
    })
  }

  private async cancelActivePrompt(operation: PromptOperation, reason: unknown): Promise<void> {
    operation.cancel?.(reason)
    await operation.completion
  }

  private createDelegate(remoteOnly = false): CredentialManagerLogin {
    const observeBrowserChild = this.observeBrowserChild.bind(this)
    const promptOperation: PromptOperation = {}
    const storage: LoginStorage = {
      deleteLoginState: remoteOnly ? async () => {} : deleteLoginStateCoordinated,
      getAuth: async (account, host, service) => {
        const current = await this.heroku.getAuthEntry()
        if (current?.account?.trim() && current.token?.trim() && (!account || current.account === account)) {
          return {account: current.account, token: current.token}
        }

        const entry = await getAuth(account, host, service)
        if (!entry.account?.trim() || !entry.token?.trim()) throw new Error('Stored credential is incomplete')
        return {account: entry.account, token: entry.token}
      },
      hasNativeStorage() {
        return Boolean(getStorageConfig().credentialStore)
      },
      readLoginState,
      removeAuth: remoteOnly ? async () => {} : removeAuth,
      saveAuth: remoteOnly ? async () => {} : saveAuth,
      writeLoginState: remoteOnly ? async () => {} : writeLoginStateCoordinated,
    }

    return new CredentialManagerLogin({
      apiClientForToken: token => createCredentialManagerPlatformAdapter(this.heroku, token),
      browser: {
        async open(url, options) {
          const open = (await import('open')).default
          const child = await open(url, {
            wait: false,
            ...(options?.browser ? {app: {name: options.browser}} : {}),
          })
          observeBrowserChild(child)
        },
      },
      config: {
        apiHost: vars.apiHost,
        apiUrl: vars.apiUrl,
        dataDir: remoteOnly ? undefined : this.config.dataDir,
        gitHost: vars.httpGitHost,
        hostname: os.hostname(),
        loginHost: this.loginHost,
        requestTimeoutMs: REQUEST_TIMEOUT,
        ssoUrl: process.env.SSO_URL,
        timeoutMs: LOGIN_TIMEOUT,
      },
      environment: {get: name => process.env[name]},
      fetch: createCredentialManagerFetchAdapter(),
      output: {
        warn: message => ux.warn(message),
        write: message => ux.stderr(/^https?:\/\//.test(message) ? greenBright(message) : message),
      },
      progress: {
        start: message => ux.action.start(message),
        stop: () => ux.action.stop(),
      },
      prompt: {
        accessToken: () => this.promptValue(promptOperation, {
          message: 'Access token',
          name: 'password',
          type: 'password',
        }),
        email: async previousAccount => {
          ux.stderr('heroku: Enter your login credentials\n')
          return this.promptValue(promptOperation, {
            defaultValue: previousAccount,
            message: 'Email',
            name: 'email',
            type: 'input',
          })
        },
        loginMethod: () => this.loginMethod(promptOperation),
        organization: defaultOrganization => this.promptValue(promptOperation, {
          defaultValue: defaultOrganization,
          message: 'Organization name',
          name: 'orgName',
          type: 'input',
        }),
        password: () => this.promptValue(promptOperation, {message: 'Password', name: 'password', type: 'password'}),
        secondFactor: () => this.promptValue(promptOperation, {message: 'Two-factor code', name: 'secondFactor', type: 'password'}),
      },
      storage,
      timers: {
        clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
        setTimeout: (handler, timeoutMs) => {
          const timer = setTimeout(() => {
            this.cancelActivePrompt(promptOperation, new Error('Login timed out')).then(handler, handler)
          }, timeoutMs)
          timer.unref()
          return timer
        },
      },
    })
  }

  private getLoginMethodFromPromptKey(key: string): LoginPromptSelection {
    if (key === '\u0003') return {cancelled: 'interrupt'}
    if (key.toLowerCase() === 'q') return {cancelled: 'quit'}
    return {method: 'browser'}
  }

  private async loginMethod(operation: PromptOperation): Promise<LoginPromptSelection> {
    ux.stderr(`heroku: Press any key to open up the browser to login or ${yellow('q')} to exit`)
    const rl = readline.createInterface({input: process.stdin, output: process.stdout})
    const canSetRawMode = typeof process.stdin.setRawMode === 'function'
    const previousRawMode = Boolean(process.stdin.isRaw)
    if (canSetRawMode) process.stdin.setRawMode(true)
    process.stdin.resume()

    let cancelPrompt: ((reason: unknown) => void) | undefined
    let onData: ((data: Buffer) => void) | undefined
    const pending = new Promise<string>((resolve, reject) => {
      cancelPrompt = reject
      onData = data => resolve(data.toString())
      process.stdin.once('data', onData)
    })
    operation.cancel = cancelPrompt
    operation.completion = pending.then(() => {}, () => {})

    try {
      const key = await pending
      ux.stdout('')
      return this.getLoginMethodFromPromptKey(key)
    } finally {
      if (onData) process.stdin.removeListener('data', onData)
      if (operation.cancel === cancelPrompt) {
        operation.cancel = undefined
        operation.completion = undefined
      }

      if (canSetRawMode) process.stdin.setRawMode(previousRawMode)
      rl.close()
    }
  }

  private async loginUnlocked(opts: Login.Options): Promise<void> {
    if (!opts.method && !opts.expiresIn && process.env.HEROKU_LEGACY_SSO !== '1' && !process.stdin.isTTY) {
      ux.error('Cannot prompt for login in a non-interactive terminal. Run `heroku login` in an interactive shell, or set HEROKU_API_KEY.', {
        code: NONINTERACTIVE_LOGIN_ERROR_CODE,
        exit: 1,
      })
    }

    try {
      const result = await this.createDelegate().login(this.normalizeOptions(opts))
      this.heroku.setAuthEntry(result)
    } catch (error) {
      if (error instanceof LoginCancelledError) {
        ux.error(error.message, {exit: error.reason === 'quit' ? 2 : 130})
      }

      throw this.mapLoginFailure(error)
    }
  }

  private mapLoginFailure(error: unknown): unknown {
    if (!(error instanceof LoginRequestError)) return error

    const body: IHerokuAPIErrorOptions = {
      ...(error.id ? {id: error.id} : {}),
      message: error.body?.message || error.message || 'Login request failed',
      ...(error.body?.resource ? {resource: error.body.resource} : {}),
    }
    const response = {
      body,
      headers: {},
      method: 'LOGIN',
      statusCode: error.status,
      url: 'https://login.invalid/',
    } as HTTP<IHerokuAPIErrorOptions>
    return new HerokuAPIError(new HTTPError(response))
  }

  private normalizeOptions(opts: Login.Options): CredentialManagerLoginOptions {
    const aliases = {b: 'browser', i: 'interactive', s: 'sso'} as const
    const method = opts.method && opts.method in aliases
      ? aliases[opts.method as keyof typeof aliases]
      : opts.method
    return {...opts, method: method as CredentialManagerLoginOptions['method']}
  }

  private observeBrowserChild(child: ChildProcess): void {
    child.once('error', cause => ux.warn(cause))
    child.once('close', code => {
      if (code !== 0) ux.warn('Cannot open browser. Continue with the manual URL above.')
    })
  }

  private async promptValue(
    operation: PromptOperation,
    {defaultValue, message, name, type}: PromptValueOptions,
  ): Promise<string> {
    const controller = new AbortController()
    const pending = prompter.prompt<Record<typeof name, string>>([{
      ...(defaultValue ? {default: defaultValue} : {}),
      message,
      name,
      type,
    }], {signal: controller.signal})
    const cancelPrompt = (reason: unknown) => controller.abort(reason)
    operation.cancel = cancelPrompt
    operation.completion = pending.then(() => {}, () => {})

    try {
      const answer = await pending
      return answer[name]
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      throw error
    } finally {
      if (operation.cancel === cancelPrompt) {
        operation.cancel = undefined
        operation.completion = undefined
      }
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation)
    this.lifecycle = result.then(() => {}, () => {})
    return result
  }
}
