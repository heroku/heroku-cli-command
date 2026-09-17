import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {restore, stub} from 'sinon'

import {LOCALHOST_DOMAINS} from '../../src/api-client.js'

const activeRoot = path.resolve('src/credential-manager-core')
const deprecatedRoot = path.resolve('src/deprecated/credential-manager-core')
const fixtureRoot = path.resolve('test/credential-manager/fixtures')

const compatibilityModules = [
  'credential-handlers/linux-handler.ts',
  'credential-handlers/macos-handler.ts',
  'credential-handlers/netrc-handler.ts',
  'credential-handlers/windows-handler.ts',
  'index.ts',
  'lib/credential-storage-selector.ts',
  'lib/login-state.ts',
  'lib/netrc-parser.ts',
  'lib/types.ts',
]

const packageJsonLookup = "join(dir, '../../../package.json')"
const relocatedPackageJsonLookup = "join(dir, '../../../../package.json')"

let commandRoot: typeof import('../../src/index.js')
let credentialSentrySdk: typeof import('../../src/credential-manager-core/lib/cli-command-telemetry.js')['credentialSentrySdk']
let externalCredentialManager: typeof import('@heroku/heroku-credential-manager')
let getAuth: typeof import('../../src/credential-manager.js')['getAuth']
let removeAuth: typeof import('../../src/credential-manager.js')['removeAuth']
let setCredentialManagerProvider: typeof import('../../src/credential-manager.js')['setCredentialManagerProvider']

type RollbackBaseline = {
  allowedRelocations: Array<{
    archived: string
    baseline: string
    path: string
  }>
  files: Array<{
    bytes: number
    path: string
    sha256: string
  }>
  packageVersion: string
  provenance: {
    commit: string
    derivation: string
    sourceRoot: string
  }
  schemaVersion: number
}

function normalizeRollbackRelocation(source: string): string {
  return source.replace(relocatedPackageJsonLookup, packageJsonLookup)
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

describe('credential-manager compatibility', function () {
  const homeEnvironmentKeys = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'] as const
  const originalHomeEnvironment: Partial<Record<(typeof homeEnvironmentKeys)[number], string>> = {}
  let temporaryHome: string

  before(async function () {
    temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'heroku-command-compatibility-home-'))
    for (const key of homeEnvironmentKeys) originalHomeEnvironment[key] = process.env[key]

    const {root} = path.parse(temporaryHome)
    process.env.HOME = temporaryHome
    process.env.USERPROFILE = temporaryHome
    process.env.HOMEDRIVE = root
    process.env.HOMEPATH = temporaryHome.slice(root.length)

    // eslint-disable-next-line n/no-extraneous-import
    externalCredentialManager = await import('@heroku/heroku-credential-manager')
    commandRoot = await import('../../src/index.js')
    const credentialManager = await import('../../src/credential-manager.js')
    const telemetry = await import('../../src/credential-manager-core/lib/cli-command-telemetry.js')
    credentialSentrySdk = telemetry.credentialSentrySdk
    getAuth = credentialManager.getAuth
    removeAuth = credentialManager.removeAuth
    setCredentialManagerProvider = credentialManager.setCredentialManagerProvider
  })

  after(function () {
    for (const key of homeEnvironmentKeys) {
      const value = originalHomeEnvironment[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }

    fs.rmSync(temporaryHome, {force: true, recursive: true})
  })

  afterEach(function () {
    setCredentialManagerProvider({
      getAuth: externalCredentialManager.getAuth,
      removeAuth: externalCredentialManager.removeAuth,
      saveAuth: externalCredentialManager.saveAuth,
    })
    restore()
    delete process.env.CI
    process.env.NODE_ENV = 'test'
    delete process.env.IS_HEROKU_TEST_ENV
    delete process.env.DISABLE_TELEMETRY
  })

  it('imports every compatibility runtime from a temporary home without touching the real home', function () {
    const realHome = originalHomeEnvironment.HOME || os.homedir()
    const childRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heroku-command-compatibility-cwd-'))
    const fixture = path.join(fixtureRoot, 'hermetic-compatibility-import.ts')
    const tsxLoader = path.resolve('node_modules/tsx/dist/esm/index.mjs')
    const builtRoot = path.resolve('lib')
    const hiddenBuiltRoot = path.join(childRoot, 'hidden-lib')
    const hadBuiltRoot = fs.existsSync(builtRoot)

    try {
      if (hadBuiltRoot) fs.renameSync(builtRoot, hiddenBuiltRoot)
      const output = execFileSync(process.execPath, [
        '--import',
        tsxLoader,
        fixture,
      ], {
        cwd: childRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          HEROKU_TEST_REAL_HOME: realHome,
          HEROKU_TEST_SOURCE_ROOT: path.resolve('.'),
          HEROKU_TEST_TEMP_HOME: temporaryHome,
          HOME: temporaryHome,
          HOMEDRIVE: process.env.HOMEDRIVE,
          HOMEPATH: process.env.HOMEPATH,
          USERPROFILE: temporaryHome,
        },
      })
      const result = JSON.parse(output) as {defaultNetrcPath: string; realHomeAccesses: string[]}

      expect(path.dirname(result.defaultNetrcPath)).to.equal(temporaryHome)
      expect(result.realHomeAccesses).to.deep.equal([])
    } finally {
      if (hadBuiltRoot) fs.renameSync(hiddenBuiltRoot, builtRoot)
      fs.rmSync(childRoot, {force: true, recursive: true})
    }
  })

  it('preserves LOCALHOST_DOMAINS on the API client and command root runtime surfaces', function () {
    expect(LOCALHOST_DOMAINS).to.deep.equal(['localhost', '127.0.0.1'])
    expect(commandRoot.LOCALHOST_DOMAINS).to.equal(LOCALHOST_DOMAINS)
  })

  it('accepts historical AuthEntry declarations from built public surfaces', function () {
    this.timeout(20_000)
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heroku-command-declarations-'))
    const builtRoot = path.join(temporaryRoot, 'build')
    const generatedFixture = path.join(temporaryRoot, 'built-declaration-compatibility.mts')
    const compiler = path.resolve('node_modules/typescript/bin/tsc')

    try {
      execFileSync(process.execPath, [
        compiler,
        '-p',
        path.resolve('tsconfig.json'),
        '--outDir',
        builtRoot,
      ], {stdio: 'pipe'})

      const fixture = fs.readFileSync(path.join(fixtureRoot, 'source-declaration-compatibility.ts'), 'utf8')
      const generatedSource = fixture.replaceAll('../../../src/', './build/')
      expect(generatedSource).to.not.equal(fixture)
      expect(generatedSource).to.not.include('../../../src/')
      fs.writeFileSync(generatedFixture, generatedSource)

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
        generatedFixture,
      ], {stdio: 'pipe'})
    } finally {
      fs.rmSync(temporaryRoot, {force: true, recursive: true})
    }
  })

  it('packs active compatibility paths but no archived rollback runtime from a hermetic build', function () {
    this.timeout(20_000)
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'heroku-command-pack-'))
    const compiler = path.resolve('node_modules/typescript/bin/tsc')

    try {
      const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as Record<string, unknown>
      delete packageJson.scripts
      fs.writeFileSync(path.join(temporaryRoot, 'package.json'), JSON.stringify(packageJson))
      execFileSync(process.execPath, [
        compiler,
        '-p',
        path.resolve('tsconfig.json'),
        '--outDir',
        path.join(temporaryRoot, 'lib'),
      ], {stdio: 'pipe'})

      const output = execFileSync('npm', [
        'pack',
        '--dry-run',
        '--foreground-scripts=false',
        '--ignore-scripts',
        '--json',
      ], {
        cwd: temporaryRoot,
        encoding: 'utf8',
      })
      const [{files}] = JSON.parse(output) as Array<{files: Array<{path: string}>}>
      const publishedPaths = files.map(file => file.path)

      expect(publishedPaths).to.include.members([
        'lib/credential-manager-core/index.d.ts',
        'lib/credential-manager-core/index.js',
        'lib/credential-manager-core/lib/netrc-parser.d.ts',
        'lib/credential-manager-core/lib/netrc-parser.js',
      ])
      expect(publishedPaths.some(publishedPath => publishedPath.startsWith('lib/deprecated/'))).to.equal(false)
      expect(fs.existsSync(path.join(temporaryRoot, '.git'))).to.equal(false)
    } finally {
      fs.rmSync(temporaryRoot, {force: true, recursive: true})
    }
  })

  it('forwards expectedToken through the injectable credential-manager wrapper', async function () {
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

  it('reports a surfaced facade error once without adding credential values to telemetry tags', async function () {
    delete process.env.CI
    process.env.NODE_ENV = 'development'
    delete process.env.IS_HEROKU_TEST_ENV
    delete process.env.DISABLE_TELEMETRY

    const error = new Error('opaque-account opaque-service opaque-token')
    setCredentialManagerProvider({
      getAuth: stub().rejects(error),
      removeAuth: stub().resolves(),
      saveAuth: stub().resolves(),
    })

    const closeStub = stub().resolves()
    stub(credentialSentrySdk, 'getClient').returns({close: closeStub} as unknown as NonNullable<ReturnType<typeof credentialSentrySdk.getClient>>)
    const captureStub = stub(credentialSentrySdk, 'captureException')
    stub(credentialSentrySdk, 'flush').resolves(true)

    let caught: unknown
    try {
      await getAuth('private-account@example.com', 'api.heroku.com', 'private-service')
    } catch (error_) {
      caught = error_
    }

    expect(caught).to.equal(error)
    expect(captureStub.calledOnce).to.equal(true)
    const reportedError: unknown = captureStub.firstCall.args[0]
    const context: unknown = captureStub.firstCall.args[1]
    expect(reportedError).to.be.instanceOf(Error)
    if (!(reportedError instanceof Error)) {
      throw new TypeError('expected credential telemetry to capture an Error')
    }

    expect(reportedError.message).to.equal('Credential manager operation failed')
    expect(reportedError.cause).to.equal(undefined)
    expect(reportedError.stack).to.not.include(error.message)
    expect(reportedError.message).to.not.include('private-account@example.com')
    expect(reportedError.message).to.not.include('private-service')
    expect(context).to.deep.equal({
      tags: {
        component: 'heroku-cli-command',
        credential_operation: 'getAuth',
        credential_store: 'unknown',
      },
    })
  })

  for (const property of ['cause', 'errors'] as const) {
    it(`does not replace a surfaced facade error when its ${property} getter throws`, async function () {
      delete process.env.CI
      process.env.NODE_ENV = 'development'
      delete process.env.IS_HEROKU_TEST_ENV
      delete process.env.DISABLE_TELEMETRY

      const original = property === 'errors'
        ? new AggregateError([], 'original aggregate failure')
        : new Error('original cause failure')
      Object.defineProperty(original, property, {
        configurable: true,
        get() {
          throw new Error(`hostile ${property} getter`)
        },
      })
      setCredentialManagerProvider({
        getAuth: stub().rejects(original),
        removeAuth: stub().resolves(),
        saveAuth: stub().resolves(),
      })
      const closeStub = stub().resolves()
      stub(credentialSentrySdk, 'getClient').returns({close: closeStub} as unknown as NonNullable<ReturnType<typeof credentialSentrySdk.getClient>>)
      const captureStub = stub(credentialSentrySdk, 'captureException')
      stub(credentialSentrySdk, 'flush').resolves(true)

      let caught: unknown
      try {
        await getAuth('private-account@example.com', 'api.heroku.com', 'private-service')
      } catch (error) {
        caught = error
      }

      expect(caught).to.equal(original)
      expect(captureStub.calledOnce).to.equal(true)
      expect(captureStub.firstCall.args[1]).to.deep.equal({
        tags: {
          component: 'heroku-cli-command',
          credential_operation: 'getAuth',
          credential_store: 'unknown',
        },
      })
    })
  }

  it('does not duplicate telemetry from a provider that already reports errors', async function () {
    delete process.env.CI
    process.env.NODE_ENV = 'development'
    delete process.env.IS_HEROKU_TEST_ENV
    delete process.env.DISABLE_TELEMETRY

    const error = new Error('deprecated provider error')
    setCredentialManagerProvider({
      getAuth: stub().rejects(error),
      removeAuth: stub().resolves(),
      reportsCredentialErrors: true,
      saveAuth: stub().resolves(),
    })
    const captureStub = stub(credentialSentrySdk, 'captureException')

    let caught: unknown
    try {
      await getAuth('private-account@example.com', 'api.heroku.com', 'private-service')
    } catch (error_) {
      caught = error_
    }

    expect(caught).to.equal(error)
    expect(captureStub.called).to.equal(false)
  })

  it('does not report expected unauthenticated credential misses', async function () {
    delete process.env.CI
    process.env.NODE_ENV = 'development'
    delete process.env.IS_HEROKU_TEST_ENV
    delete process.env.DISABLE_TELEMETRY

    const error = new externalCredentialManager.NativeCredentialNotFoundError('missing')
    setCredentialManagerProvider({
      getAuth: stub().rejects(error),
      removeAuth: stub().resolves(),
      saveAuth: stub().resolves(),
    })
    const captureStub = stub(credentialSentrySdk, 'captureException')

    let caught: unknown
    try {
      await getAuth('user@example.com', 'api.heroku.com')
    } catch (error_) {
      caught = error_
    }

    expect(caught).to.equal(error)
    expect(captureStub.called).to.equal(false)
  })

  it('keeps active compatibility modules on the external package graph', function () {
    for (const relativePath of compatibilityModules) {
      const source = fs.readFileSync(path.join(activeRoot, relativePath), 'utf8')
      expect(source, relativePath).to.include('@deprecated')
      expect(source, relativePath).to.include('@heroku/heroku-credential-manager')
      expect(source, relativePath).to.not.include('deprecated/credential-manager-core')
    }

    const telemetrySource = fs.readFileSync(path.join(activeRoot, 'lib/cli-command-telemetry.ts'), 'utf8')
    expect(telemetrySource).to.not.include('deprecated/credential-manager-core')
  })

  it('keeps every rollback file on the pinned v13.2.0 baseline except for package metadata relocation', async function () {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(fixtureRoot, 'v13.2.0-rollback-baseline.json'),
      'utf8',
    )) as RollbackBaseline
    expect(manifest.schemaVersion).to.equal(1)
    expect(manifest.packageVersion).to.equal('13.2.0')
    expect(manifest.provenance).to.deep.equal({
      commit: 'd114e3d2a1afb269f63bf9c3985a7017e096dbc4',
      derivation: 'SHA-256 and UTF-8 byte length from each file at the recorded base HEAD',
      sourceRoot: 'src/credential-manager-core',
    })
    expect(manifest.allowedRelocations).to.deep.equal([{
      archived: relocatedPackageJsonLookup,
      baseline: packageJsonLookup,
      path: 'lib/cli-command-telemetry.ts',
    }])

    const archivedFiles = listFiles(deprecatedRoot).sort()
    const baselineFiles = manifest.files.map(file => file.path).sort()
    expect(archivedFiles).to.deep.equal(baselineFiles)

    for (const baseline of manifest.files) {
      const rollbackPath = path.join(deprecatedRoot, baseline.path)
      const rollbackSource = fs.readFileSync(rollbackPath, 'utf8')
      const normalizedRollbackSource = normalizeRollbackRelocation(rollbackSource)

      expect(Buffer.byteLength(normalizedRollbackSource), `${baseline.path} byte length`).to.equal(baseline.bytes)
      expect(sha256(normalizedRollbackSource), `${baseline.path} SHA-256`).to.equal(baseline.sha256)

      if (baseline.path === 'lib/cli-command-telemetry.ts') {
        expect(rollbackSource).to.include(relocatedPackageJsonLookup)
        expect(rollbackSource).to.not.include(packageJsonLookup)
        expect(rollbackSource.split(relocatedPackageJsonLookup)).to.have.length(2)
      } else {
        expect(normalizedRollbackSource, baseline.path).to.equal(rollbackSource)
      }
    }

    const telemetry = await import('../../src/deprecated/credential-manager-core/lib/cli-command-telemetry.js')
    delete process.env.CI
    process.env.NODE_ENV = 'development'
    delete process.env.IS_HEROKU_TEST_ENV
    delete process.env.DISABLE_TELEMETRY

    // eslint-disable-next-line unicorn/no-useless-undefined
    stub(telemetry.credentialSentrySdk, 'getClient').returns(undefined)
    // eslint-disable-next-line unicorn/no-useless-undefined
    const initStub = stub(telemetry.credentialSentrySdk, 'init').returns(undefined)
    const captureStub = stub(telemetry.credentialSentrySdk, 'captureException')
    stub(telemetry.credentialSentrySdk, 'flush').resolves(true)

    const providerError = new Error('opaque-account opaque-service opaque-token')
    await telemetry.reportCredentialStoreError(providerError, {
      credentialStore: externalCredentialManager.CredentialStore.MacOSKeychain,
      operation: 'getAuth',
    })

    expect(initStub.firstCall.args[0]?.release).to.equal('@heroku-cli/command@13.2.0')
    expect(captureStub.firstCall.args[0]).to.equal(providerError)
  })
})
