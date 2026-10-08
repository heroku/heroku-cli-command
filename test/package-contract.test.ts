import {HTTP} from '@heroku/http-call'
import {expect} from 'chai'
import {readdirSync, readFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import ts from 'typescript'

const packageName = '@heroku/heroku-credential-manager'
const expectedVersion = '0.1.0'
const packagePath = resolve('node_modules', packageName)
const httpCallPackageName = '@heroku/http-call'
const httpCallVersion = '5.5.2'
const httpCallPackagePath = resolve('node_modules', httpCallPackageName)

type PackageManifest = {
  dependencies: Record<string, string>;
  exports: Record<string, unknown>;
  version: string;
}

type Lockfile = {
  packages: Record<string, {
    dependencies?: Record<string, string>;
    integrity?: string;
    resolved?: string;
    version?: string;
  }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function readDeclarations(path: string): string {
  return readdirSync(path, {withFileTypes: true})
    .flatMap(entry => {
      const entryPath = join(path, entry.name)

      if (entry.isDirectory()) return readDeclarations(entryPath)
      return entry.name.endsWith('.d.ts') ? readFileSync(entryPath, 'utf8') : []
    })
    .join('\n')
}

function interfaceMethodNames(declarations: string, interfaceName: string): string[] {
  const sourceFile = ts.createSourceFile('declarations.d.ts', declarations, ts.ScriptTarget.Latest, true)
  const methodNames: string[] = []

  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      methodNames.push(...node.members.filter(member => ts.isMethodSignature(member)).map(member => member.name.getText(sourceFile)))
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return methodNames.toSorted()
}

function classMemberNames(declarations: string, className: string): string[] {
  const sourceFile = ts.createSourceFile('declarations.d.ts', declarations, ts.ScriptTarget.Latest, true)
  const methodNames: string[] = []

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      methodNames.push(...node.members.flatMap(member => member.name ? member.name.getText(sourceFile) : []))
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return methodNames.toSorted()
}

describe('package contracts', () => {
  it(`detects unexpected ${packageName} HerokuApiClientLike methods regardless of formatting`, () => {
    const declarations = `
      interface HerokuApiClientLike {
        delete<T>(path: string): Promise<T>
        get<T>(path: string): Promise<T>
        post<T>(path: string): Promise<T>
      }
    `

    expect(interfaceMethodNames(declarations, 'HerokuApiClientLike')).to.deep.equal(['delete', 'get', 'post'])
  })

  it(`pins the immutable ${packageName} package and lockfile artifact`, () => {
    const manifest = readJson<PackageManifest>(resolve('package.json'))
    const lockfile = readJson<Lockfile>(resolve('package-lock.json'))
    const lockRoot = lockfile.packages['']
    const lockPackage = lockfile.packages[`node_modules/${packageName}`]

    expect(manifest.dependencies[packageName]).to.equal(expectedVersion)
    expect(lockRoot.dependencies?.[packageName]).to.equal(expectedVersion)
    expect(lockPackage).to.include({
      integrity: 'sha512-jonzLCL5kt79oL3TZYxFsJ9d7eO6ZrGJmsjDkAjDb4CNFvC72DH5Ke6xZ+G9iN5HgQ36Y7Mji+V5h+QS0bEj/Q==',
      resolved: 'https://registry.npmjs.org/@heroku/heroku-credential-manager/-/heroku-credential-manager-0.1.0.tgz',
      version: expectedVersion,
    })
  })

  it(`installs the expected ${packageName} package API contract`, () => {
    const installedManifest = readJson<PackageManifest>(join(packagePath, 'package.json'))
    const declarations = readDeclarations(packagePath)

    expect(installedManifest.version).to.equal(expectedVersion)
    expect(installedManifest.exports).to.include.all.keys('.', './login')
    expect(interfaceMethodNames(declarations, 'HerokuApiClientLike')).to.deep.equal(['delete', 'get'])
    expect(declarations).not.to.match(/\bLoginHttp\w*/)
  })

  it(`pins the verified ${httpCallPackageName} version in the manifest and lockfile`, () => {
    const manifest = readJson<PackageManifest>(resolve('package.json'))
    const lockfile = readJson<Lockfile>(resolve('package-lock.json'))

    expect(manifest.dependencies[httpCallPackageName]).to.equal(httpCallVersion)
    expect(lockfile.packages[''].dependencies?.[httpCallPackageName]).to.equal(httpCallVersion)
    expect(lockfile.packages[`node_modules/${httpCallPackageName}`].version).to.equal(httpCallVersion)
    expect(readJson<PackageManifest>(join(httpCallPackagePath, 'package.json')).version).to.equal(httpCallVersion)
  })

  it('provides the transport hooks required by the login adapter', async () => {
    const declarations = readFileSync(join(httpCallPackagePath, 'lib/http.d.ts'), 'utf8')
    const requiredHooks = ['_maybeRetry', '_redirect', '_request', '_wait']
    const runtimePrototype = HTTP.prototype as unknown as Record<string, unknown>

    expect(classMemberNames(declarations, 'HTTP')).to.include.members(requiredHooks)
    for (const hook of requiredHooks) expect(runtimePrototype[hook]).to.be.a('function')

    const request = new HTTP('https://example.test') as unknown as {
      _maybeRetry(error: Error): Promise<void>;
      _request(): Promise<void>;
      _wait(delay: number): Promise<void>;
    }
    const calls: string[] = []
    request._wait = async () => {
      calls.push('_wait')
    }

    request._request = async () => {
      calls.push('_request')
    }

    await request._maybeRetry(Object.assign(new Error('socket reset'), {code: 'ECONNRESET'}))
    expect(calls).to.deep.equal(['_wait', '_request'])
  })
})
