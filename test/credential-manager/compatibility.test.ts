import * as externalCredentialManager from '@heroku/heroku-credential-manager'
import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {restore, stub} from 'sinon'

import * as credentialManagerCore from '../../src/credential-manager-core/index.js'
import {credentialSentrySdk} from '../../src/credential-manager-core/lib/cli-command-telemetry.js'
import * as credentialStorageSelector from '../../src/credential-manager-core/lib/credential-storage-selector.js'
import * as loginState from '../../src/credential-manager-core/lib/login-state.js'
import netrc, * as netrcParser from '../../src/credential-manager-core/lib/netrc-parser.js'
import {
  getAuth as getFacadeAuth,
  removeAuth,
  setCredentialManagerProvider,
} from '../../src/credential-manager.js'
import * as commandRoot from '../../src/index.js'

const activeRoot = path.resolve('src/credential-manager-core')
const archivedRoot = path.resolve('src/deprecated/credential-manager-core')
const fixtureRoot = path.resolve('test/credential-manager/fixtures')

const compatibilityModules = [
  'credential-handlers/linux-handler.ts',
  'credential-handlers/macos-handler.ts',
  'credential-handlers/netrc-handler.ts',
  'credential-handlers/windows-handler.ts',
  'index.ts',
  'lib/credential-manager-adapter.ts',
  'lib/credential-storage-selector.ts',
  'lib/login-state.ts',
  'lib/netrc-parser.ts',
  'lib/types.ts',
]

const externalRuntimeExports = [
  'CredentialStore',
  'LinuxHandler',
  'MacOSHandler',
  'Netrc',
  'NetrcHandler',
  'WindowsHandler',
  'deleteLoginState',
  'getCredentialHandler',
  'getNativeCredentialStore',
  'getStorageConfig',
  'parse',
  'readLoginState',
  'writeLoginState',
] as const

const packageJsonLookup = "join(dir, '../../../package.json')"
const relocatedPackageJsonLookup = "join(dir, '../../../../package.json')"

type StorageBaseline = {
  allowedRelocations: Array<{archived: string; baseline: string; path: string}>
  files: Array<{bytes: number; path: string; sha256: string}>
  packageVersion: string
  provenance: {commit: string; derivation: string; ref: string; sourceRoot: string}
  schemaVersion: number
}

function listFiles(root: string, relativeRoot = ''): string[] {
  return fs.readdirSync(path.join(root, relativeRoot), {withFileTypes: true}).flatMap(entry => {
    const relativePath = path.join(relativeRoot, entry.name)
    return entry.isDirectory() ? listFiles(root, relativePath) : [relativePath.split(path.sep).join('/')]
  })
}

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

function enableCredentialTelemetry() {
  delete process.env.CI
  process.env.NODE_ENV = 'development'
  delete process.env.IS_HEROKU_TEST_ENV
  delete process.env.DISABLE_TELEMETRY

  const close = stub().resolves()
  stub(credentialSentrySdk, 'getClient').returns({close} as unknown as NonNullable<ReturnType<typeof credentialSentrySdk.getClient>>)
  const captureException = stub(credentialSentrySdk, 'captureException')
  stub(credentialSentrySdk, 'flush').resolves(true)
  return captureException
}

function expectCredentialTelemetry(
  captureException: ReturnType<typeof stub>,
  error: Error,
  operation: 'getAuth' | 'listKeychainAccounts' | 'removeAuth' | 'saveAuth',
): void {
  expect(captureException.calledOnce).to.equal(true)
  expect(captureException.firstCall.args).to.deep.equal([
    error,
    {
      tags: {
        component: 'heroku-cli-command',
        credential_operation: operation,
        credential_store: externalCredentialManager.CredentialStore.MacOSKeychain,
      },
    },
  ])
}

describe('credential-manager compatibility', function () {
  afterEach(function () {
    setCredentialManagerProvider({
      getAuth: credentialManagerCore.getAuth,
      removeAuth: credentialManagerCore.removeAuth,
      saveAuth: credentialManagerCore.saveAuth,
    })
    restore()
    process.env.NODE_ENV = 'test'
  })

  it('reports saveAuth native backend failures and preserves netrc fallback behavior', async function () {
    stub(process, 'platform').value('darwin')
    const error = new Error('native save failed')
    stub(externalCredentialManager.MacOSHandler.prototype, 'saveAuth').throws(error)
    const netrcSave = stub(externalCredentialManager.NetrcHandler.prototype, 'saveAuthForHosts').resolves()
    const captureException = enableCredentialTelemetry()

    await credentialManagerCore.saveAuth('user@example.com', 'token', ['api.heroku.com'], 'custom-service')

    expect(netrcSave.calledOnceWithExactly(
      {login: 'user@example.com', password: 'token'},
      ['api.heroku.com'],
    )).to.equal(true)
    expectCredentialTelemetry(captureException, error, 'saveAuth')
  })

  it('reports surfaced getAuth native backend failures without falling back', async function () {
    stub(process, 'platform').value('darwin')
    const error = new Error('native read failed')
    stub(externalCredentialManager.MacOSHandler.prototype, 'getAuth').throws(error)
    const netrcGet = stub(externalCredentialManager.NetrcHandler.prototype, 'getAuth')
    const captureException = enableCredentialTelemetry()
    setCredentialManagerProvider({
      getAuth: credentialManagerCore.getAuth,
      removeAuth: credentialManagerCore.removeAuth,
      saveAuth: credentialManagerCore.saveAuth,
    })

    let caught: unknown
    try {
      await getFacadeAuth('user@example.com', 'api.heroku.com', 'custom-service')
    } catch (error_) {
      caught = error_
    }

    expect(caught).to.equal(error)
    expect(netrcGet.called).to.equal(false)
    expectCredentialTelemetry(captureException, error, 'getAuth')
  })

  it('does not report NativeCredentialNotFoundError during getAuth fallback', async function () {
    stub(process, 'platform').value('darwin')
    const missing = new externalCredentialManager.NativeCredentialNotFoundError('missing')
    stub(externalCredentialManager.MacOSHandler.prototype, 'getAuth').throws(missing)
    stub(externalCredentialManager.NetrcHandler.prototype, 'getAuth').resolves({
      login: 'user@example.com',
      password: 'netrc-token',
    })
    const captureException = enableCredentialTelemetry()

    const auth = await credentialManagerCore.getAuth('user@example.com', 'api.heroku.com')

    expect(auth).to.deep.equal({account: 'user@example.com', token: 'netrc-token'})
    expect(captureException.called).to.equal(false)
  })

  it('reports listKeychainAccounts backend failures and preserves the empty result', async function () {
    stub(process, 'platform').value('darwin')
    const error = new Error('native list failed')
    stub(externalCredentialManager.MacOSHandler.prototype, 'listAccounts').throws(error)
    const captureException = enableCredentialTelemetry()

    const accounts = await commandRoot.listKeychainAccounts('custom-service')

    expect(accounts).to.deep.equal([])
    expectCredentialTelemetry(captureException, error, 'listKeychainAccounts')
  })

  it('reports removeAuth backend failures and preserves netrc cleanup arguments', async function () {
    stub(process, 'platform').value('darwin')
    const error = new Error('native remove failed')
    stub(externalCredentialManager.MacOSHandler.prototype, 'getAuth').throws(error)
    const nativeRemove = stub(externalCredentialManager.MacOSHandler.prototype, 'removeAuth')
    const netrcRemove = stub(externalCredentialManager.NetrcHandler.prototype, 'removeAuthForHosts').resolves()
    const captureException = enableCredentialTelemetry()

    await commandRoot.removeAuth(
      'user@example.com',
      ['api.heroku.com'],
      'custom-service',
      'expected-token',
    )

    expect(nativeRemove.called).to.equal(false)
    expect(netrcRemove.calledOnceWithExactly(
      ['api.heroku.com'],
      'user@example.com',
      'expected-token',
    )).to.equal(true)
    expectCredentialTelemetry(captureException, error, 'removeAuth')
  })

  it('preserves external runtime identities except command-owned storage adapters', async function () {
    for (const name of externalRuntimeExports) {
      // eslint-disable-next-line import/namespace
      expect(credentialManagerCore[name], `credential-manager-core ${name}`).to.equal(externalCredentialManager[name])
      // eslint-disable-next-line import/namespace
      expect(commandRoot[name], `command root ${name}`).to.equal(externalCredentialManager[name])
    }

    for (const name of ['getAuth', 'listKeychainAccounts', 'removeAuth', 'saveAuth'] as const) {
      // eslint-disable-next-line import/namespace
      expect(commandRoot[name], `command root ${name}`).to.equal(credentialManagerCore[name])
      // eslint-disable-next-line import/namespace
      expect(commandRoot[name], `${name} is command-owned`).to.not.equal(externalCredentialManager[name])
    }

    const handlers = await Promise.all([
      import('../../src/credential-manager-core/credential-handlers/linux-handler.js'),
      import('../../src/credential-manager-core/credential-handlers/macos-handler.js'),
      import('../../src/credential-manager-core/credential-handlers/netrc-handler.js'),
      import('../../src/credential-manager-core/credential-handlers/windows-handler.js'),
    ])

    expect(handlers[0].LinuxHandler).to.equal(externalCredentialManager.LinuxHandler)
    expect(handlers[1].MacOSHandler).to.equal(externalCredentialManager.MacOSHandler)
    expect(handlers[2].NetrcHandler).to.equal(externalCredentialManager.NetrcHandler)
    expect(handlers[3].WindowsHandler).to.equal(externalCredentialManager.WindowsHandler)
    expect(credentialStorageSelector.CredentialStore).to.equal(externalCredentialManager.CredentialStore)
    expect(credentialStorageSelector.getStorageConfig).to.equal(externalCredentialManager.getStorageConfig)
    expect(loginState.readLoginState).to.equal(externalCredentialManager.readLoginState)
    expect(netrcParser.Netrc).to.equal(externalCredentialManager.Netrc)
    expect(netrcParser.parse).to.equal(externalCredentialManager.parse)
    expect(netrc).to.be.instanceOf(externalCredentialManager.Netrc)
  })

  it('compiles the historical optional AuthEntry declarations', function () {
    const compiler = path.resolve('node_modules/typescript/bin/tsc')
    execFileSync(process.execPath, [
      compiler,
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'es2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      path.join(fixtureRoot, 'source-declaration-compatibility.ts'),
    ], {stdio: 'pipe'})
  })

  it('forwards expectedToken exactly as the provider removeAuth fourth argument', async function () {
    const provider = {
      getAuth: stub().resolves({account: 'user@example.com', token: 'token'}),
      removeAuth: stub().resolves(),
      saveAuth: stub().resolves(),
    }
    setCredentialManagerProvider(provider)

    await removeAuth('user@example.com', ['api.heroku.com'], 'custom-service', 'expected-token')

    expect(provider.removeAuth.calledOnceWithExactly(
      'user@example.com',
      ['api.heroku.com'],
      'custom-service',
      'expected-token',
    )).to.equal(true)
  })

  it('archives the exact command-v13.2.0 storage sources except the documented lookup relocation', function () {
    const baseline = JSON.parse(fs.readFileSync(
      path.join(fixtureRoot, 'v13.2.0-storage-baseline.json'),
      'utf8',
    )) as StorageBaseline

    expect(baseline).to.include({packageVersion: '13.2.0', schemaVersion: 1})
    expect(baseline.provenance).to.deep.equal({
      commit: '7c77d2c15600bfc2a5c0087b9bf7651c0fc1cc17',
      derivation: 'SHA-256 and UTF-8 byte length from each file at command-v13.2.0',
      ref: 'command-v13.2.0',
      sourceRoot: 'src/credential-manager-core',
    })
    expect(baseline.allowedRelocations).to.deep.equal([{
      archived: relocatedPackageJsonLookup,
      baseline: packageJsonLookup,
      path: 'lib/cli-command-telemetry.ts',
    }])
    expect(listFiles(archivedRoot).sort()).to.deep.equal(baseline.files.map(file => file.path).sort())

    for (const file of baseline.files) {
      const archivedSource = fs.readFileSync(path.join(archivedRoot, file.path), 'utf8')
      const normalizedSource = archivedSource.replace(relocatedPackageJsonLookup, packageJsonLookup)
      expect(Buffer.byteLength(normalizedSource), `${file.path} byte length`).to.equal(file.bytes)
      expect(sha256(normalizedSource), `${file.path} SHA-256`).to.equal(file.sha256)

      if (file.path === 'lib/cli-command-telemetry.ts') {
        expect(archivedSource).to.include(relocatedPackageJsonLookup)
        expect(archivedSource).to.not.include(packageJsonLookup)
      } else {
        expect(archivedSource).to.equal(normalizedSource)
      }
    }
  })

  it('keeps the active graph dormant from archived implementation imports', function () {
    for (const relativePath of compatibilityModules) {
      const source = fs.readFileSync(path.join(activeRoot, relativePath), 'utf8')
      expect(source, relativePath).to.include('@heroku/heroku-credential-manager')
      expect(source, relativePath).to.not.include('deprecated/credential-manager-core')
    }

    const activeSources = listFiles(path.resolve('src'))
      .filter(relativePath => relativePath.endsWith('.ts') && !relativePath.startsWith('deprecated/'))
    for (const relativePath of activeSources) {
      const source = fs.readFileSync(path.resolve('src', relativePath), 'utf8')
      expect(source, relativePath).to.not.match(/(?:from|import\()\s*['"][^'"]*deprecated\//)
    }
  })

  it('emits all historical paths without emitting lib/deprecated', function () {
    this.timeout(20_000)
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heroku-command-compatibility-build-'))
    const outputRoot = path.join(temporaryRoot, 'lib')
    const compiler = path.resolve('node_modules/typescript/bin/tsc')

    try {
      execFileSync(process.execPath, [
        compiler,
        '-p',
        path.resolve('tsconfig.json'),
        '--outDir',
        outputRoot,
      ], {stdio: 'pipe'})

      for (const relativePath of [...compatibilityModules, 'lib/cli-command-telemetry.ts']) {
        const emittedPath = relativePath.replace(/\.ts$/, '.js')
        expect(fs.existsSync(path.join(outputRoot, 'credential-manager-core', emittedPath)), emittedPath).to.equal(true)
        expect(fs.existsSync(path.join(outputRoot, 'credential-manager-core', emittedPath.replace(/\.js$/, '.d.ts'))), emittedPath).to.equal(true)
      }

      expect(fs.existsSync(path.join(outputRoot, 'deprecated'))).to.equal(false)
    } finally {
      fs.rmSync(temporaryRoot, {force: true, recursive: true})
    }
  })
})
