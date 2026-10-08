import {
  type HerokuApiResponse,
  Login,
  type LoginDependencies,
  LoginRequestError,
} from '@heroku/heroku-credential-manager/login'
import {HTTP, HTTPError, type HTTPRequestOptions} from '@heroku/http-call'
import {Config} from '@oclif/core/config'
import * as chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import nock from 'nock'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import * as sinon from 'sinon'

import {Command as CommandBase} from '../src/command.js'
import {
  type CommandPlatformClient,
  createCredentialManagerFetchAdapter,
  createCredentialManagerPlatformAdapter,
} from '../src/credential-manager-login-adapters.js'

chai.use(chaiAsPromised)
const {expect} = chai
const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
type ProxyPolicy = {env: NodeJS.ProcessEnv}
const proxyPolicy = (require('@heroku/http-call/lib/proxy.js') as {default: ProxyPolicy}).default

const httpError = (method: 'DELETE' | 'GET') => {
  const response = new HTTP(`https://api.heroku.com/${method.toLowerCase()}-http-error`, {method})
  response.body = {id: `${method.toLowerCase()}-failed`, message: `${method} failed`}
  Object.defineProperty(response, 'response', {
    value: {headers: {'X-Request-Id': `${method.toLowerCase()}-request`}, statusCode: 429},
  })
  return new HTTPError(response)
}

class Command extends CommandBase {
  async run() {}
}

const prompt: LoginDependencies['prompt'] = {
  async accessToken() {
    return 'token-b'
  },
  async email() {
    return 'user@example.com'
  },
  async loginMethod() {
    return {method: 'browser'}
  },
  async organization() {
    return 'example'
  },
  async password() {
    return 'password'
  },
  async secondFactor() {
    return '123456'
  },
}

const storage: LoginDependencies['storage'] = {
  async deleteLoginState() {},
  async getAuth() {
    return {account: 'old@example.com', token: 'token-a'}
  },
  hasNativeStorage() {
    return false
  },
  readLoginState: async () => undefined,
  async removeAuth() {},
  async saveAuth() {},
  async writeLoginState() {},
}

describe('credential manager login adapters', () => {
  describe('Platform adapter', () => {
    afterEach(() => {
      nock.cleanAll()
      sinon.restore()
    })

    it('exposes exactly get/delete and forwards operation-token request options for both methods', async () => {
      const calls: Array<{method: string; options: Record<string, unknown>; path: string}> = []
      const getSignal = new AbortController().signal
      const deleteSignal = new AbortController().signal
      const client: CommandPlatformClient = {
        async delete<T>(path: string, options?: HTTPRequestOptions) {
          calls.push({method: 'delete', options: options as Record<string, unknown>, path})
          return {body: undefined as T, headers: {}, statusCode: 204}
        },
        async get<T>(path: string, options?: HTTPRequestOptions) {
          calls.push({method: 'get', options: options as Record<string, unknown>, path})
          return {body: {ok: true} as T, headers: {'X-Array': ['two', 'three'], 'X-Scalar': 'one'}, statusCode: 200}
        },
      }
      const adapter = createCredentialManagerPlatformAdapter(client, 'token-b')

      expect(Object.keys(adapter).sort()).to.deep.equal(['delete', 'get'])
      const response = await adapter.get('/account', {
        headers: {Authorization: 'Bearer token-a', Range: 'id ..; max=2', 'X-Package': 'yes'},
        signal: getSignal,
        timeoutMs: 321,
      })
      await adapter.delete('/oauth/sessions/~', {
        headers: {authorization: 'Bearer token-a', 'X-Package': 'yes'},
        signal: deleteSignal,
        timeoutMs: 654,
      })

      expect(response).to.deep.equal({
        body: {ok: true},
        headers: {'x-array': ['two', 'three'], 'x-scalar': 'one'},
        status: 200,
      })
      expect(calls[0]).to.deep.equal({
        method: 'get',
        options: {
          headers: {Authorization: 'Bearer token-b', Range: 'id ..; max=2', 'X-Package': 'yes'},
          partial: true,
          retryAuth: false,
          signal: getSignal,
          timeout: 321,
        },
        path: '/account',
      })
      expect(calls[1]).to.deep.equal({
        method: 'delete',
        options: {
          headers: {Authorization: 'Bearer token-b', 'X-Package': 'yes'},
          partial: true,
          retryAuth: false,
          signal: deleteSignal,
          timeout: 654,
        },
        path: '/oauth/sessions/~',
      })
    })

    it('normalizes HTTP errors and preserves transport errors for both methods', async () => {
      const transportErrors = {
        delete: new Error('delete transport failed'),
        get: new Error('get transport failed'),
      }
      const client: CommandPlatformClient = {
        async delete(path: string) {
          if (path.endsWith('http-error')) throw httpError('DELETE')

          throw transportErrors.delete
        },
        async get(path: string) {
          if (path.endsWith('http-error')) throw httpError('GET')

          throw transportErrors.get
        },
      }
      const adapter = createCredentialManagerPlatformAdapter(client, 'token-b')

      for (const method of ['delete', 'get'] as const) {
        // eslint-disable-next-line no-await-in-loop
        expect(await adapter[method](`/${method}-http-error`)).to.deep.equal({
          body: {id: `${method}-failed`, message: `${method.toUpperCase()} failed`},
          headers: {'x-request-id': `${method}-request`},
          status: 429,
        })
        // eslint-disable-next-line no-await-in-loop
        expect(await adapter[method](`/${method}-transport-error`).catch((error: unknown) => error)).to.equal(transportErrors[method])
      }
    })

    it('honors active abort and timeout through the command transport for both methods', async () => {
      class NoRetryHTTP<T> extends HTTP<T> {
        async _maybeRetry(error: Error): Promise<void> {
          throw error
        }
      }
      const client: CommandPlatformClient = {
        delete: async <T>(path: string, options?: HTTPRequestOptions) => NoRetryHTTP.delete<T>(`https://api.heroku.com${path}`, options),
        get: async <T>(path: string, options?: HTTPRequestOptions) => NoRetryHTTP.get<T>(`https://api.heroku.com${path}`, options),
      }
      const adapter = createCredentialManagerPlatformAdapter(client, 'token-b')

      for (const method of ['delete', 'get'] as const) {
        const abortPath = `/adapter-${method}-abort`
        nock('https://api.heroku.com').intercept(abortPath, method.toUpperCase()).delay(100).reply(200, {})
        const controller = new AbortController()
        const pending = adapter[method](abortPath, {signal: controller.signal, timeoutMs: 1000})
        setTimeout(() => {
          controller.abort(new Error(`${method} caller cancelled`))
        }, 10)
        // eslint-disable-next-line no-await-in-loop
        await expect(pending).to.be.rejectedWith('The operation was aborted')

        const timeoutPath = `/adapter-${method}-timeout`
        nock('https://api.heroku.com').intercept(timeoutPath, method.toUpperCase()).delay(100).reply(200, {})
        // eslint-disable-next-line no-await-in-loop
        await expect(adapter[method](timeoutPath, {timeoutMs: 10})).to.be.rejectedWith('Request timed out')
      }
    })

    it('keeps Range verbatim and exposes a 206 and Next-Range', async () => {
      const client: CommandPlatformClient = {
        async delete() {
          throw new Error('not used')
        },
        async get<T>(_path: string, options?: HTTPRequestOptions) {
          expect(options?.headers?.Range).to.equal('id 10..20; max=10')
          return {body: [{id: '10'}] as T, headers: {'Next-Range': 'id 21..30; max=10'}, statusCode: 206}
        },
      }

      const response = await createCredentialManagerPlatformAdapter(client, 'token-b').get('/oauth/authorizations', {
        headers: {Range: 'id 10..20; max=10'},
      })

      expect(response.status).to.equal(206)
      expect(response.headers['next-range']).to.equal('id 21..30; max=10')
    })

    it('turns the first 401 into LoginRequestError without command auth/login hooks or token replacement', async () => {
      const config = new Config({root: resolve(__dirname, '../package.json')})
      const command = new Command([], config)
      command.heroku.setAuthEntry({account: 'old@example.com', token: 'token-a'})
      const loginHook = sinon.spy(command.heroku, 'login')
      let factoryToken: string | undefined
      const api = nock('https://api.heroku.com', {reqheaders: {authorization: 'Bearer token-b'}})
        .get('/account')
        .reply(401, {id: 'unauthorized', message: 'token rejected'})
      const login = new Login({
        apiClientForToken(token) {
          factoryToken = token
          return createCredentialManagerPlatformAdapter(command.heroku, token)
        },
        config: {ssoUrl: 'https://sso.heroku.com/example', timeoutMs: 1000},
        prompt,
        storage,
      })

      const error = await login.login({method: 'sso'}).catch((error: unknown) => error)

      expect(error).to.be.instanceOf(LoginRequestError)
      expect(error).to.include({id: 'unauthorized', status: 401})
      expect(factoryToken).to.equal('token-b')
      expect(loginHook.called).to.equal(false)
      expect(command.heroku.auth).to.equal('token-a')
      expect(api.isDone()).to.equal(true)
    })
  })

  describe('FetchLike adapter', () => {
    afterEach(() => {
      nock.cleanAll()
      nock.disableNetConnect()
      sinon.restore()
    })

    it('preserves browser-initiation POST method, headers, body, and native Response shape', async () => {
      const scope = nock('https://cli-auth.heroku.com', {
        reqheaders: {'content-type': 'application/json', 'x-package': 'browser'},
      })
        .post('/auth', {description: 'browser login'})
        .reply(201, {browser_url: '/browser'}, {'X-Result': 'created'})
      const fetch = createCredentialManagerFetchAdapter()
      const response = await fetch(new URL('https://cli-auth.heroku.com/auth'), {
        body: JSON.stringify({description: 'browser login'}),
        headers: {'content-type': 'application/json', 'x-package': 'browser'},
        method: 'POST',
        redirect: 'error',
      })

      expect(response.constructor.name).to.equal('Response')
      expect(response.status).to.equal(201)
      expect(response.headers.get('x-result')).to.equal('created')
      expect(await response.json()).to.deep.equal({browser_url: '/browser'})
      expect(scope.isDone()).to.equal(true)
    })

    it('supports interactive OAuth POST from a Request and preserves external cancellation', async () => {
      const scope = nock('https://api.heroku.com', {reqheaders: {authorization: 'Basic abc'}})
        .post('/oauth/authorizations', {scope: ['global']})
        .reply(200, {access_token: {token: 'new-token'}})
      const fetch = createCredentialManagerFetchAdapter()
      // Node 20 provides Request at runtime; the lint engine's compatibility table predates that support.
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      const request = new Request('https://api.heroku.com/oauth/authorizations', {
        body: JSON.stringify({scope: ['global']}),
        headers: {authorization: 'Basic abc', 'content-type': 'application/json'},
        method: 'POST',
        redirect: 'error',
      })
      const response = await fetch(request)

      expect(await response.json()).to.deep.equal({access_token: {token: 'new-token'}})
      expect(scope.isDone()).to.equal(true)

      nock('https://api.heroku.com').get('/slow').delay(100).reply(200, {ok: true})
      const controller = new AbortController()
      const pending = fetch('https://api.heroku.com/slow', {redirect: 'error', signal: controller.signal})
      const reason = new Error('caller cancelled')
      controller.abort(reason)
      await expect(pending).to.be.rejectedWith('caller cancelled')
    })

    it('normalizes all fetch body types and body-bearing Request overrides', async () => {
      const received: string[] = []
      nock('https://api.heroku.com')
        .post('/blob').reply(200, (_uri, body) => {
          received.push(body as string)
          return {}
        })
        .post('/array-buffer').reply(200, (_uri, body) => {
          received.push(body as string)
          return {}
        })
        .post('/form-data').reply(200, (_uri, body) => {
          received.push(body as string)
          return {}
        })
        .post('/params').reply(200, (_uri, body) => {
          received.push(body as string)
          return {}
        })
        .post('/override').reply(200, (_uri, body) => {
          received.push(body as string)
          return {}
        })
      const fetch = createCredentialManagerFetchAdapter()
      /* eslint-disable n/no-unsupported-features/node-builtins, no-undef -- Node 20+ provides these fetch globals (FormData/Blob) at runtime; the lint engine's compatibility table predates that support */
      const formData = new FormData()
      formData.append('field', 'form-body')
      const bodies: Array<[BodyInit, string]> = [
        [new Blob(['blob-body']), '/blob'],
        [new TextEncoder().encode('buffer-body').buffer, '/array-buffer'],
        [formData, '/form-data'],
        [new URLSearchParams({a: 'one', b: 'two'}), '/params'],
      ]
      for (const [body, path] of bodies) {
        // eslint-disable-next-line no-await-in-loop
        await fetch(`https://api.heroku.com${path}`, {body, method: 'POST', redirect: 'error'})
      }

      const original = new Request('https://api.heroku.com/override', {
        body: 'original-body',
        method: 'POST',
        redirect: 'error',
      })
      await fetch(original, {body: 'override-body', method: 'POST', redirect: 'error'})

      expect(received[0]).to.equal('blob-body')
      expect(received[1]).to.equal('buffer-body')
      expect(received[2]).to.include('form-body')
      expect(received[3]).to.equal('a=one&b=two')
      expect(received[4]).to.equal('override-body')
      expect(original.bodyUsed).to.equal(false)
      /* eslint-enable n/no-unsupported-features/node-builtins, no-undef */
    })

    it('marks a consumed body-bearing Request as used', async () => {
      nock('https://api.heroku.com').post('/request-body', 'request-body').reply(200, {})
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      const request = new Request('https://api.heroku.com/request-body', {
        body: 'request-body',
        method: 'POST',
        redirect: 'error',
      })
      await createCredentialManagerFetchAdapter()(request)
      expect(request.bodyUsed).to.equal(true)
    })

    it('passes null bodies to native Response for bodyless statuses', async () => {
      const fetch = createCredentialManagerFetchAdapter()
      for (const status of [204, 205, 304]) {
        nock('https://api.heroku.com').get(`/bodyless-${status}`).reply(status, 'must-not-reach-Response')
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(`https://api.heroku.com/bodyless-${status}`, {redirect: 'error'})
        expect(response.status).to.equal(status)
        // eslint-disable-next-line no-await-in-loop
        expect(await response.text()).to.equal('')
      }
    })

    it('replays identical complete POST bytes after a real socket reset', async () => {
      const bodies: string[] = []
      nock.enableNetConnect('127.0.0.1')
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        bodies.push(Buffer.concat(chunks).toString())
        if (bodies.length === 1) {
          request.socket.destroy()
        } else {
          response.setHeader('content-type', 'application/json')
          response.end('{"ok":true}')
        }
      })
      await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not bind')
      try {
        const response = await createCredentialManagerFetchAdapter()(`http://127.0.0.1:${address.port}/retry-body`, {
          body: 'complete-post-body',
          method: 'POST',
          redirect: 'error',
        })
        expect(await response.json()).to.deep.equal({ok: true})
        expect(bodies).to.deep.equal(['complete-post-body', 'complete-post-body'])
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close(error => {
            error ? reject(error) : resolve()
          })
        })
        nock.disableNetConnect()
      }
    })

    it('returns non-2xx poll Responses and leaves status retries to the package', async () => {
      const fetch = createCredentialManagerFetchAdapter()
      const single = nock('https://cli-auth.heroku.com').get('/single-poll').reply(503, {message: 'wait'})
      const response = await fetch('https://cli-auth.heroku.com/single-poll', {method: 'GET', redirect: 'error'})
      expect(response.status).to.equal(503)
      expect(await response.json()).to.deep.equal({message: 'wait'})
      expect(single.isDone()).to.equal(true)

      let polls = 0
      nock('https://cli-auth.heroku.com')
        .post('/auth')
        .reply(200, {browser_url: '/browser', cli_url: '/poll', token: 'temporary'})
        .get('/poll')
        .twice()
        .reply(() => {
          polls++
          return polls === 1 ? [503, {message: 'not ready'}] : [200, {access_token: 'token-b'}]
        })
      const login = new Login({
        apiClientForToken: _token => ({
          async delete() {
            throw new Error('not used')
          },
          async get<T>(): Promise<HerokuApiResponse<T>> {
            return {body: {email: 'user@example.com'} as T, headers: {}, status: 200}
          },
        }),
        browser: {async open() {}},
        config: {loginHost: 'https://cli-auth.heroku.com', timeoutMs: 1000},
        fetch,
        prompt,
        storage,
      })

      expect(await login.login({method: 'browser'})).to.deep.equal({account: 'user@example.com', token: 'token-b'})
      expect(polls).to.equal(2)
    })

    it('rejects redirects instead of following them with the default transport', async () => {
      nock('https://cli-auth.heroku.com')
        .post('/auth')
        .reply(302, undefined, {location: 'https://elsewhere.example.test/auth'})

      await expect(createCredentialManagerFetchAdapter()('https://cli-auth.heroku.com/auth', {
        body: '{}',
        headers: {'content-type': 'application/json'},
        method: 'POST',
        redirect: 'error',
      })).to.be.rejectedWith(TypeError, 'Redirects are not allowed')
    })

    it('rejects redirects from an injected command transport', async () => {
      class InjectedTransport<T> extends HTTP<T> {
        static async request<T>(url: string, options?: HTTPRequestOptions): Promise<HTTP<T>> {
          const request = new this<T>(url, options)
          request.body = 'redirect body' as T
          Object.defineProperty(request, 'response', {
            value: {headers: {location: 'https://elsewhere.example.test'}, statusCode: 302},
          })
          await request._redirect()
          return request
        }
      }

      await expect(createCredentialManagerFetchAdapter(InjectedTransport)('https://cli-auth.heroku.com/auth', {
        method: 'POST',
        redirect: 'error',
      })).to.be.rejectedWith(TypeError, 'Redirects are not allowed')
    })

    it('leaves transient network retries to the command transport', async () => {
      let attempts = 0
      class RetryingTransport<T> extends HTTP<T> {
        static async request<T>(url: string, options?: HTTPRequestOptions): Promise<HTTP<T>> {
          attempts++
          // Models command transport-owned retry rather than any retry in the adapter.
          if (attempts === 1) return this.request<T>(url, options)
          return {body: {ok: true} as T, headers: {}, statusCode: 200} as HTTP<T>
        }
      }

      const response = await createCredentialManagerFetchAdapter(RetryingTransport)('https://cli-auth.heroku.com/retry', {
        method: 'GET',
        redirect: 'error',
      })

      expect(await response.json()).to.deep.equal({ok: true})
      expect(attempts).to.equal(2)
    })

    it('preserves http-call 5.5.2 retry count and error policy', async () => {
      const cases: Array<{attempts: number; code: string}> = [
        {attempts: 6, code: 'ECONNRESET'},
        {attempts: 6, code: 'ENOTFOUND'},
        {attempts: 1, code: 'ENETUNREACH'},
        {attempts: 1, code: 'CERT_HAS_EXPIRED'},
      ]
      const timer = {unref() {}}
      const timeout = sinon.stub(globalThis, 'setTimeout').callsFake(((handler: (...arguments_: unknown[]) => void) => {
        queueMicrotask(handler)
        return timer
      }) as unknown as typeof setTimeout)
      try {
        for (const expected of cases) {
          let attempts = 0
          class PolicyTransport<T> extends HTTP<T> {
            async _request(): Promise<void> {
              attempts++
              await this._maybeRetry(Object.assign(new Error(expected.code), {code: expected.code}))
            }
          }

          // eslint-disable-next-line no-await-in-loop
          await expect(createCredentialManagerFetchAdapter(PolicyTransport)('https://api.heroku.com/retry-policy', {
            redirect: 'error',
          })).to.be.rejectedWith(expected.code)
          expect(attempts).to.equal(expected.attempts)
        }
      } finally {
        timeout.restore()
      }
    })

    it('preserves http-call 5.5.2 exponential jitter delays', async () => {
      const delays: number[] = []
      let attempts = 0
      const random = sinon.stub(Math, 'random').returns(0.5)
      const timer = {unref() {}}
      const timeout = sinon.stub(globalThis, 'setTimeout').callsFake(((handler: (...arguments_: unknown[]) => void, delay?: number) => {
        delays.push(delay ?? 0)
        queueMicrotask(handler)
        return timer
      }) as unknown as typeof setTimeout)
      class JitterTransport<T> extends HTTP<T> {
        async _request(): Promise<void> {
          attempts++
          if (attempts < 4) await this._maybeRetry(Object.assign(new Error('socket reset'), {code: 'ECONNRESET'}))
          else {
            this.body = {ok: true} as T
            Object.defineProperty(this, 'response', {value: {headers: {}, statusCode: 200}})
          }
        }
      }
      try {
        await createCredentialManagerFetchAdapter(JitterTransport)('https://api.heroku.com/retry-jitter', {redirect: 'error'})
        expect(delays).to.deep.equal([250, 450, 850])
      } finally {
        random.restore()
        timeout.restore()
      }
    })

    it('uses the command transport proxy and NO_PROXY path', async () => {
      const previousHttpsProxy = process.env.HTTPS_PROXY
      const previousNoProxy = process.env.NO_PROXY
      process.env.HTTPS_PROXY = 'http://proxy.example.test:8080'
      process.env.NO_PROXY = 'direct.example.test'
      class InspectingTransport<T> extends HTTP<T> {
        static agents: unknown[] = []

        static async request<T>(url: string, options?: HTTPRequestOptions): Promise<HTTP<T>> {
          const request = new this<T>(url, options)
          this.agents.push(request.options.agent)
          return {body: {ok: true} as T, headers: {}, statusCode: 200} as HTTP<T>
        }
      }

      try {
        const fetch = createCredentialManagerFetchAdapter(InspectingTransport)
        await fetch('https://proxied.example.test/path', {redirect: 'error'})
        await fetch('https://direct.example.test/path', {redirect: 'error'})
        expect(InspectingTransport.agents[0]).to.exist
        expect(InspectingTransport.agents[1]).to.equal(undefined)
      } finally {
        if (previousHttpsProxy === undefined) delete process.env.HTTPS_PROXY
        else process.env.HTTPS_PROXY = previousHttpsProxy
        if (previousNoProxy === undefined) delete process.env.NO_PROXY
        else process.env.NO_PROXY = previousNoProxy
      }
    })

    it('configures custom CA for direct, proxied, and NO_PROXY HTTPS requests', async () => {
      const previousHttpsProxy = process.env.HTTPS_PROXY
      const previousNoProxy = process.env.NO_PROXY
      const previousCertFile = process.env.SSL_CERT_FILE
      process.env.HTTPS_PROXY = 'http://proxy.example.test:8080'
      process.env.NO_PROXY = 'direct.example.test'
      const directory = mkdtempSync(`${tmpdir()}/login-adapter-ca-`)
      const certificate = resolve(directory, 'custom-ca.pem')
      writeFileSync(certificate, 'custom-ca')
      process.env.SSL_CERT_FILE = certificate
      class InspectingTransport<T> extends HTTP<T> {
        static options: HTTPRequestOptions[] = []

        static async request<T>(url: string, options?: HTTPRequestOptions): Promise<HTTP<T>> {
          const request = new this<T>(url, options)
          this.options.push(request.options)
          return {body: {ok: true} as T, headers: {}, statusCode: 200} as HTTP<T>
        }
      }

      try {
        const fetch = createCredentialManagerFetchAdapter(InspectingTransport)
        await fetch('https://proxied.example.test/path', {redirect: 'error'})
        await fetch('https://direct.example.test/path', {redirect: 'error'})
        expect(InspectingTransport.options[0].agent).to.exist
        expect(InspectingTransport.options[1].agent).to.exist
        expect((InspectingTransport.options[0].agent as {options?: {ca?: Buffer[]}}).options?.ca?.[0].toString()).to.equal('custom-ca')
        expect((InspectingTransport.options[1].agent as {options?: {ca?: Buffer[]}}).options?.ca?.[0].toString()).to.equal('custom-ca')
      } finally {
        rmSync(directory, {force: true, recursive: true})
        if (previousHttpsProxy === undefined) delete process.env.HTTPS_PROXY
        else process.env.HTTPS_PROXY = previousHttpsProxy
        if (previousNoProxy === undefined) delete process.env.NO_PROXY
        else process.env.NO_PROXY = previousNoProxy
        if (previousCertFile === undefined) delete process.env.SSL_CERT_FILE
        else process.env.SSL_CERT_FILE = previousCertFile
      }
    })

    it('reevaluates proxy, NO_PROXY, and CA settings after process.env object replacement', async () => {
      const originalEnvironment = process.env
      const directory = mkdtempSync(`${tmpdir()}/login-adapter-replaced-env-`)
      const certificate = resolve(directory, 'custom-ca.pem')
      writeFileSync(certificate, 'replacement-ca')
      process.env = {
        ...originalEnvironment,
        HTTPS_PROXY: 'http://replacement-proxy.example.test:8080',
        NO_PROXY: 'replacement-direct.example.test',
        SSL_CERT_FILE: certificate,
      }
      class InspectingTransport<T> extends HTTP<T> {
        static options: HTTPRequestOptions[] = []

        static async request<T>(url: string, options?: HTTPRequestOptions): Promise<HTTP<T>> {
          const request = new this<T>(url, options)
          this.options.push(request.options)
          return {body: {ok: true} as T, headers: {}, statusCode: 200} as HTTP<T>
        }
      }

      try {
        const fetch = createCredentialManagerFetchAdapter(InspectingTransport)
        await fetch('https://replacement-proxied.example.test/path', {redirect: 'error'})
        await fetch('https://replacement-direct.example.test/path', {redirect: 'error'})
        expect(InspectingTransport.options[0].agent).to.exist
        expect(InspectingTransport.options[1].agent).to.exist
        expect((InspectingTransport.options[1].agent as {options?: {ca?: Buffer[]}}).options?.ca?.[0].toString()).to.equal('replacement-ca')
      } finally {
        process.env = originalEnvironment
        rmSync(directory, {force: true, recursive: true})
        proxyPolicy.env = originalEnvironment
      }
    })

    it('restores proxy policy identity before unrelated plain HTTP construction', async () => {
      const originalEnvironment = process.env
      const originalProxyEnvironment = proxyPolicy.env
      process.env = {
        ...originalEnvironment,
        HTTPS_PROXY: 'http://temporary-adapter-proxy.example.test:8080',
        NO_PROXY: '',
      }
      class InspectingTransport<T> extends HTTP<T> {
        static async request<T>(url: string, options?: HTTPRequestOptions): Promise<HTTP<T>> {
          const request = new this<T>(url, options)
          request.body = {ok: true} as T
          Object.defineProperty(request, 'response', {value: {headers: {}, statusCode: 200}})
          return request
        }
      }

      try {
        await createCredentialManagerFetchAdapter(InspectingTransport)('https://adapter.example.test/path', {redirect: 'error'})
      } finally {
        process.env = originalEnvironment
      }

      expect(proxyPolicy.env).to.equal(originalProxyEnvironment, `proxy policy still points at ${proxyPolicy.env.HTTPS_PROXY}`)
      const plain = new HTTP('https://unrelated.example.test/path')
      const proxyOptions = (plain.options.agent as undefined | {proxyOptions?: {host?: string}})?.proxyOptions
      expect(proxyOptions?.host).to.not.equal('temporary-adapter-proxy.example.test')
    })

    it('keeps current direct HTTPS direct when prior proxy policy is stale', async () => {
      const originalEnvironment = process.env
      const originalProxyEnvironment = proxyPolicy.env
      const staleEnvironment = {HTTPS_PROXY: 'http://stale-proxy.example.test:8080'}
      proxyPolicy.env = staleEnvironment
      process.env = {
        ...originalEnvironment, HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '*',
      }
      class InspectingTransport<T> extends HTTP<T> {
        static agent: unknown

        static async request<T>(url: string, options?: HTTPRequestOptions): Promise<HTTP<T>> {
          const request = new this<T>(url, options)
          this.agent = request.options.agent
          return {body: {ok: true} as T, headers: {}, statusCode: 200} as HTTP<T>
        }
      }

      try {
        await createCredentialManagerFetchAdapter(InspectingTransport)('https://direct-current.example.test/path', {redirect: 'error'})
        expect(InspectingTransport.agent).to.equal(undefined)
        expect(proxyPolicy.env).to.equal(staleEnvironment)
      } finally {
        process.env = originalEnvironment
        proxyPolicy.env = originalProxyEnvironment
      }
    })

    it('uses current HTTP proxy instead of stale prior HTTP proxy', async () => {
      const originalEnvironment = process.env
      const originalProxyEnvironment = proxyPolicy.env
      const staleEnvironment = {HTTP_PROXY: 'http://stale-http-proxy.example.test:8080'}
      proxyPolicy.env = staleEnvironment
      process.env = {
        ...originalEnvironment,
        HTTP_PROXY: 'http://current-http-proxy.example.test:8181',
      }
      delete process.env.HTTPS_PROXY
      delete process.env.https_proxy
      delete process.env.http_proxy
      delete process.env.NO_PROXY
      delete process.env.no_proxy
      const observations: Array<{agent: unknown; url: string}> = []
      class InspectingTransport<T> extends HTTP<T> {
        static async request<T>(url: string, options?: HTTPRequestOptions): Promise<HTTP<T>> {
          const request = new this<T>(url, options)
          observations.push({agent: request.options.agent, url})
          return {body: {ok: true} as T, headers: {}, statusCode: 200} as HTTP<T>
        }
      }

      try {
        await createCredentialManagerFetchAdapter(InspectingTransport)('http://current-http.example.test/path', {
          method: 'GET',
          redirect: 'error',
        })
        expect(observations).to.have.length(1)
        expect(observations[0].url).to.equal('http://current-http.example.test/path')
        expect(observations[0].agent, `current HTTP_PROXY=${process.env.HTTP_PROXY}`).to.exist
        const {proxyOptions} = (observations[0].agent as {proxyOptions?: {host?: string; port?: string}})
        expect(proxyOptions).to.deep.include({host: 'current-http-proxy.example.test', port: '8181'})
        expect(proxyPolicy.env).to.equal(staleEnvironment)
      } finally {
        process.env = originalEnvironment
        proxyPolicy.env = originalProxyEnvironment
      }
    })

    it('disables the command transport timeout so package cancellation owns timeouts', async () => {
      class InspectingTransport<T> extends HTTP<T> {
        static timeout: number | undefined

        async _request(): Promise<void> {
          InspectingTransport.timeout = this.options.timeout
          this.body = {ok: true} as T
          Object.defineProperty(this, 'response', {value: {headers: {}, statusCode: 200}})
        }
      }
      await createCredentialManagerFetchAdapter(InspectingTransport)('https://api.heroku.com/timeout-owner', {redirect: 'error'})
      expect(InspectingTransport.timeout).to.equal(0)
    })

    it('aborts promptly while the command transport is in retry backoff', async () => {
      const controller = new AbortController()
      nock('https://api.heroku.com').get('/backoff').replyWithError({code: 'ECONNRESET', message: 'socket reset'})
      const started = Date.now()
      const pending = createCredentialManagerFetchAdapter()('https://api.heroku.com/backoff', {
        redirect: 'error',
        signal: controller.signal,
      })
      setTimeout(() => {
        controller.abort(new Error('abort during backoff'))
      }, 10)
      await expect(pending).to.be.rejectedWith('abort during backoff')
      expect(Date.now() - started).to.be.lessThan(100)
    })

    it('unrefs the retry backoff timer', async () => {
      let unrefCalls = 0
      const timeout = sinon.stub(globalThis, 'setTimeout').callsFake(((() => ({
        unref() {
          unrefCalls++
        },
      })) as unknown) as typeof setTimeout)
      class BackoffTransport<T> extends HTTP<T> {
        async _request(): Promise<void> {
          await this._maybeRetry(Object.assign(new Error('socket reset'), {code: 'ECONNRESET'}))
        }
      }
      const controller = new AbortController()
      const pending = createCredentialManagerFetchAdapter(BackoffTransport)('https://api.heroku.com/backoff-unref', {
        redirect: 'error',
        signal: controller.signal,
      })
      await Promise.resolve()
      controller.abort(new Error('stop unref test'))
      await expect(pending).to.be.rejectedWith('stop unref test')
      expect(unrefCalls).to.equal(1)
      timeout.restore()
    })

    it('cancels retry backoff so no request callback runs after abort', async () => {
      let requests = 0
      const scheduled = new Set<ReturnType<typeof setTimeout>>()
      const originalSetTimeout = setTimeout
      const originalClearTimeout = clearTimeout
      sinon.stub(globalThis, 'setTimeout').callsFake(((handler: (...arguments_: unknown[]) => void, timeout?: number, ...arguments_: unknown[]) => {
        const timer = originalSetTimeout(handler, timeout, ...arguments_)
        scheduled.add(timer)
        return timer
      }) as typeof setTimeout)
      sinon.stub(globalThis, 'clearTimeout').callsFake((timer => {
        scheduled.delete(timer as ReturnType<typeof setTimeout>)
        originalClearTimeout(timer)
      }))
      class BackoffTransport<T> extends HTTP<T> {
        async _request(): Promise<void> {
          requests++
          if (requests === 1) {
            await this._maybeRetry(Object.assign(new Error('socket reset'), {code: 'ECONNRESET'}))
          }
        }
      }
      const controller = new AbortController()
      const pending = createCredentialManagerFetchAdapter(BackoffTransport)('https://api.heroku.com/backoff-leak', {
        redirect: 'error',
        signal: controller.signal,
      })
      await new Promise(resolve => {
        originalSetTimeout(resolve, 0)
      })
      controller.abort(new Error('cancel retry timer'))
      await expect(pending).to.be.rejectedWith('cancel retry timer')
      expect(scheduled.size).to.equal(0)
      await new Promise(resolve => {
        originalSetTimeout(resolve, 300)
      })
      expect(requests).to.equal(1)
    })

    it('honors package request timeout aborts', async () => {
      nock('https://api.heroku.com').post('/oauth/authorizations').delay(100).reply(200, {})
      const timedLogin = new Login({
        apiClientForToken() {
          throw new Error('not used')
        },
        config: {requestTimeoutMs: 10, timeoutMs: 10_000},
        fetch: createCredentialManagerFetchAdapter(),
        prompt,
        storage,
      })
      await expect(timedLogin.login({method: 'interactive'})).to.be.rejectedWith('Login request timed out')
    })
  })
})
