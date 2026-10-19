import type {AddressInfo} from 'node:net'

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
import {createServer} from 'node:http'
import path from 'node:path'
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
const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

      expect(Object.keys(adapter).toSorted()).to.deep.equal(['delete', 'get'])
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
      const config = new Config({root: path.resolve(__dirname, '../package.json')})
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

      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      expect(response).to.be.instanceOf(Response)
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
        nock('https://api.heroku.com').get(`/bodyless-${status}`).reply(status)
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(`https://api.heroku.com/bodyless-${status}`, {redirect: 'error'})
        expect(response.status).to.equal(status)
        // eslint-disable-next-line no-await-in-loop
        expect(await response.text()).to.equal('')
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

    it('rejects redirects instead of following them', async () => {
      nock('https://cli-auth.heroku.com')
        .post('/auth')
        .reply(302, undefined, {location: 'https://elsewhere.example.test/auth'})

      // Native fetch rejects a 3xx with a TypeError when `redirect: 'error'` is set.
      await expect(createCredentialManagerFetchAdapter()('https://cli-auth.heroku.com/auth', {
        body: '{}',
        headers: {'content-type': 'application/json'},
        method: 'POST',
        redirect: 'error',
      })).to.be.rejectedWith(TypeError)
    })

    const proxyEnvKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const

    const clearProxyEnv = () => {
      const saved = Object.fromEntries(proxyEnvKeys.map(key => [key, process.env[key]]))
      for (const key of proxyEnvKeys) Reflect.deleteProperty(process.env, key)
      return () => {
        for (const key of proxyEnvKeys) {
          if (saved[key] === undefined) Reflect.deleteProperty(process.env, key)
          else process.env[key] = saved[key]
        }
      }
    }

    it('uses native fetch with no dispatcher when no proxy env var is set', async () => {
      const restoreProxyEnv = clearProxyEnv()
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response('{}', {status: 200}))
      try {
        await createCredentialManagerFetchAdapter()('https://api.heroku.com/no-proxy', {redirect: 'error'})
        expect(fetchStub.lastCall.args[1]).to.not.have.property('dispatcher')
      } finally {
        fetchStub.restore()
        restoreProxyEnv()
      }
    })

    it('drives a real proxied GET through the installed undici (regression: cross-undici dispatcher)', async () => {
      const restoreProxyEnv = clearProxyEnv()
      nock.enableNetConnect()
      let proxiedUrl: string | undefined
      const proxy = createServer((req, res) => {
        proxiedUrl = req.url
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({proxied: true}))
      })
      await new Promise<void>(resolve => {
        proxy.listen(0, '127.0.0.1', () => {
          resolve();
        })
      })
      try {
        process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
        // Before the fix this threw `InvalidArgumentError: invalid onRequestStart
        // method`: the installed undici's EnvHttpProxyAgent was handed to Node's
        // built-in (different-copy) fetch, which can't drive it.
        const response = await createCredentialManagerFetchAdapter()('http://api.heroku.example/account', {redirect: 'error'})
        expect(response.status).to.equal(200)
        expect(await response.json()).to.deep.equal({proxied: true})
        expect(proxiedUrl).to.equal('http://api.heroku.example/account')
      } finally {
        await new Promise<void>(resolve => {
          proxy.close(() => {
            resolve();
          })
        })
        restoreProxyEnv()
      }
    })

    it('proxies a body-bearing Request by decomposing it for the installed undici', async () => {
      const restoreProxyEnv = clearProxyEnv()
      nock.enableNetConnect()
      let received: {body: string; method?: string; url?: string} = {body: ''}
      const proxy = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', chunk => {
          chunks.push(chunk as Buffer)
        })
        req.on('end', () => {
          received = {body: Buffer.concat(chunks).toString(), method: req.method, url: req.url}
          res.writeHead(200, {'content-type': 'application/json'})
          res.end(JSON.stringify({ok: true}))
        })
      })
      await new Promise<void>(resolve => {
        proxy.listen(0, '127.0.0.1', () => {
          resolve();
        })
      })
      try {
        process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
        // eslint-disable-next-line n/no-unsupported-features/node-builtins
        const request = new Request('http://api.heroku.example/oauth/authorizations', {
          body: JSON.stringify({scope: ['global']}),
          headers: {authorization: 'Basic abc', 'content-type': 'application/json'},
          method: 'POST',
          redirect: 'error',
        })
        const response = await createCredentialManagerFetchAdapter()(request)
        expect(response.status).to.equal(200)
        expect(received.method).to.equal('POST')
        expect(received.url).to.equal('http://api.heroku.example/oauth/authorizations')
        expect(JSON.parse(received.body)).to.deep.equal({scope: ['global']})
      } finally {
        await new Promise<void>(resolve => {
          proxy.close(() => {
            resolve();
          })
        })
        restoreProxyEnv()
      }
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
