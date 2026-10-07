#!/usr/bin/env node

import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')
const rollbackPrefix = 'heroku-command-credential-rollback-'
const baselinePath = 'test/credential-manager/fixtures/v13.2.0-storage-baseline.json'
const archivedRoot = 'src/deprecated/credential-manager-core'
const externalPackage = '@heroku/heroku-credential-manager'
const baselinePackageLookup = "join(dir, '../../../package.json')"
const relocatedPackageLookup = "join(dir, '../../../../package.json')"
const expectedRepositoryReferences = new Set([
  'git+https://github.com/heroku/heroku-cli-command.git',
  'github:heroku/heroku-cli-command',
  'heroku/heroku-cli-command',
  'https://github.com/heroku/heroku-cli-command.git',
  'https://github.com/heroku/heroku-cli-command',
])
const signalExitCodes = {SIGHUP: 129, SIGINT: 130, SIGTERM: 143}
const supportedSignals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGHUP', 'SIGINT', 'SIGTERM']
const {values: options} = parseArgs({
  options: {
    'internal-failure-marker': {type: 'string'},
    'internal-hold-marker': {type: 'string'},
    'self-test-cleanup': {type: 'boolean'},
    'self-test-guards': {type: 'boolean'},
  },
  strict: true,
})

const copyEntries = [
  '.c8rc.json',
  '.mocharc.json',
  'eslint.config.mjs',
  'package-lock.json',
  'package.json',
  'src',
  'test',
  'tsconfig.json',
]

const rollbackReplacements = new Map([
  ['src/credential-manager-core/index.ts', [
    ["from './lib/credential-manager-adapter.js'", "from '../deprecated/credential-manager-core/index.js'"],
    ["from './lib/types.js'", "from '../deprecated/credential-manager-core/lib/types.js'"],
    ["from '@heroku/heroku-credential-manager'", "from '../deprecated/credential-manager-core/index.js'"],
    ['  NativeCredentialNotFoundError,\n', ''],
  ]],
  ['src/credential-manager-core/lib/credential-manager-adapter.ts', [
    ["from '@heroku/heroku-credential-manager'", "from '../../deprecated/credential-manager-core/index.js'"],
    ["from './cli-command-telemetry.js'", "from '../../deprecated/credential-manager-core/lib/cli-command-telemetry.js'"],
  ]],
  ['src/credential-manager-core/lib/credential-storage-selector.ts', [
    ["from '@heroku/heroku-credential-manager'", "from '../../deprecated/credential-manager-core/lib/credential-storage-selector.js'"],
  ]],
  ['src/credential-manager-core/lib/login-state.ts', [
    ["from '@heroku/heroku-credential-manager'", "from '../../deprecated/credential-manager-core/lib/login-state.js'"],
  ]],
  ['src/credential-manager-core/lib/netrc-parser.ts', [
    ["from '@heroku/heroku-credential-manager'", "from '../../deprecated/credential-manager-core/lib/netrc-parser.js'"],
  ]],
  ['src/credential-manager-core/lib/types.ts', [
    ["from '@heroku/heroku-credential-manager'", "from '../../deprecated/credential-manager-core/lib/types.js'"],
  ]],
  ['src/index.ts', [
    ["from './credential-manager-core/lib/credential-manager-adapter.js'", "from './deprecated/credential-manager-core/index.js'"],
    ["from './credential-manager-core/lib/types.js'", "from './deprecated/credential-manager-core/lib/types.js'"],
    ["from '@heroku/heroku-credential-manager'", "from './deprecated/credential-manager-core/index.js'"],
    ['  NativeCredentialNotFoundError,\n', ''],
  ]],
  ...['linux', 'macos', 'netrc', 'windows'].map(handler => [
    `src/credential-manager-core/credential-handlers/${handler}-handler.ts`,
    [[
      `from '${externalPackage}'`,
      `from '../../deprecated/credential-manager-core/credential-handlers/${handler}-handler.js'`,
    ]],
  ]),
  ['src/credential-manager.ts', [
    ["from './credential-manager-core/lib/credential-manager-adapter.js'", "from './deprecated/credential-manager-core/index.js'"],
  ]],
])

const focusedTests = [
  'test/credential-manager/index.test.ts',
  'test/credential-manager/credential-handlers/linux-handler.test.ts',
  'test/credential-manager/credential-handlers/macos-handler.test.ts',
  'test/credential-manager/credential-handlers/netrc-handler.test.ts',
  'test/credential-manager/credential-handlers/windows-handler.test.ts',
  'test/credential-manager/lib/credential-storage-selector.test.ts',
  'test/credential-manager/lib/login-state.test.ts',
]

let activeChild
let cleanupStarted = false
let dependencyIsolation = 'not installed'
let isolatedDependenciesReadOnly = false
let realDependencyFingerprint
let temporaryRoot
const confinedSecrets = []

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function read(relativePath, root = repositoryRoot) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function listFiles(root, relativeRoot = '') {
  return fs.readdirSync(path.join(root, relativeRoot), {withFileTypes: true}).flatMap(entry => {
    const relativePath = path.join(relativeRoot, entry.name)
    return entry.isDirectory()
      ? listFiles(root, relativePath)
      : [relativePath.split(path.sep).join('/')]
  })
}

function copyTree(source, destination) {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination, process.platform === 'win32' ? 'junction' : undefined)
    return
  }

  if (stat.isDirectory()) {
    fs.mkdirSync(destination, {mode: stat.mode, recursive: true})
    for (const entry of fs.readdirSync(source)) copyTree(path.join(source, entry), path.join(destination, entry))
    fs.chmodSync(destination, stat.mode)
    return
  }

  if (stat.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(destination, stat.mode)
    return
  }

  throw new Error(`unsupported dependency entry type: ${source}`)
}

function treeFingerprint(root) {
  const hash = createHash('sha256')
  const visit = (absolutePath, relativePath) => {
    const stat = fs.lstatSync(absolutePath)
    const metadata = {
      mode: stat.mode.toString(8),
      path: relativePath.split(path.sep).join('/'),
      size: stat.size,
      target: stat.isSymbolicLink() ? fs.readlinkSync(absolutePath) : undefined,
      type: fileKind(stat),
    }
    hash.update(JSON.stringify(metadata))
    if (stat.isFile()) hash.update(fs.readFileSync(absolutePath))
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, entry), path.join(relativePath, entry))
      }
    }
  }

  visit(root, '.')
  return hash.digest('hex')
}

function makeTreeReadOnly(root) {
  const stat = fs.lstatSync(root)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) makeTreeReadOnly(path.join(root, entry))
  }

  // Preserve read/execute permissions while removing every write bit.
  // eslint-disable-next-line no-bitwise
  fs.chmodSync(root, stat.mode & ~0o222)
}

function makeTreeWritable(root) {
  const stat = fs.lstatSync(root)
  if (stat.isSymbolicLink()) return
  // eslint-disable-next-line no-bitwise
  fs.chmodSync(root, stat.mode | 0o200)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) makeTreeWritable(path.join(root, entry))
  }
}

function cleanupTemporaryRoot() {
  if (cleanupStarted) return
  cleanupStarted = true
  if (temporaryRoot && isolatedDependenciesReadOnly) {
    const dependencyRoot = path.join(temporaryRoot, 'node_modules')
    if (fs.existsSync(dependencyRoot)) makeTreeWritable(dependencyRoot)
  }

  if (temporaryRoot) fs.rmSync(temporaryRoot, {force: true, recursive: true})
  temporaryRoot = undefined
}

for (const signal of supportedSignals) {
  process.on(signal, () => {
    if (activeChild && !activeChild.killed) activeChild.kill(signal)
    cleanupTemporaryRoot()
    // Conventional signal status must be set synchronously after cleanup.
    // eslint-disable-next-line n/no-process-exit
    process.exit(signalExitCodes[signal])
  })
}

function redact(value) {
  let redacted = value
  for (const secret of confinedSecrets) {
    if (secret.length >= 6) redacted = redacted.replaceAll(secret, '[redacted]')
  }

  return redacted
    .replaceAll(/((?:_authToken|_auth|password|token|api[_-]?key|session)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .replaceAll(/(https?:\/\/)[^/@\s]+@/g, '$1[redacted]@')
}

async function run(command, arguments_, runOptions = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: runOptions.cwd ?? repositoryRoot,
      encoding: 'utf8',
      env: runOptions.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    activeChild = child
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({
      code, signal, stderr, stdout,
    }))
  })
  activeChild = undefined

  if (runOptions.printOutput) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }

  if (result.code !== 0) {
    const output = redact([result.stdout, result.stderr].filter(Boolean).join('\n').trim())
    throw new Error(`${command} ${arguments_.join(' ')} failed with ${result.signal ?? `exit ${result.code}`}${output ? `\n${output}` : ''}`)
  }

  return runOptions.rawOutput ? result.stdout : result.stdout.trim()
}

function fileKind(stat) {
  if (stat.isFile()) return 'file'
  if (stat.isDirectory()) return 'directory'
  if (stat.isSymbolicLink()) return 'symlink'
  if (stat.isBlockDevice()) return 'block-device'
  if (stat.isCharacterDevice()) return 'character-device'
  if (stat.isFIFO()) return 'fifo'
  if (stat.isSocket()) return 'socket'
  return 'unknown'
}

async function captureRepositoryState() {
  const rawOptions = {cwd: repositoryRoot, rawOutput: true}
  const status = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], rawOptions)
  const diff = await run('git', ['diff', '--binary', '--no-ext-diff'], rawOptions)
  const stagedDiff = await run('git', ['diff', '--binary', '--cached', '--no-ext-diff'], rawOptions)
  const untracked = status.split('\0')
    .filter(record => record.startsWith('?? '))
    .map(record => record.slice(3))
    .sort()
  const untrackedMetadata = untracked.map(relativePath => {
    const absolutePath = path.join(repositoryRoot, relativePath)
    const stat = fs.lstatSync(absolutePath)
    return {
      content: stat.isFile() ? sha256(fs.readFileSync(absolutePath)) : undefined,
      mode: stat.mode.toString(8),
      path: relativePath,
      size: stat.size,
      target: stat.isSymbolicLink() ? fs.readlinkSync(absolutePath) : undefined,
      type: fileKind(stat),
    }
  })

  return sha256(JSON.stringify({
    diff, stagedDiff, status, untrackedMetadata,
  }))
}

function assertExternalSourceActive(root = repositoryRoot) {
  const adapter = read('src/credential-manager-core/lib/credential-manager-adapter.ts', root)
  const coreIndex = read('src/credential-manager-core/index.ts', root)
  const commandIndex = read('src/index.ts', root)

  assert.match(adapter, /from '@heroku\/heroku-credential-manager'/, 'adapter must use the external credential-manager package')
  assert.match(coreIndex, /from '@heroku\/heroku-credential-manager'/, 'core facade must use the external credential-manager package')
  assert.match(commandIndex, /from '@heroku\/heroku-credential-manager'/, 'package facade must use the external credential-manager package')
  for (const relativePath of listFiles(path.join(root, 'src')).filter(file => file.endsWith('.ts') && !file.startsWith('deprecated/'))) {
    assert.doesNotMatch(
      read(path.join('src', relativePath), root),
      /(?:from|import\()\s*['"][^'"]*deprecated\//,
      `real active source imports archived code: src/${relativePath}`,
    )
  }
}

function assertNegativePreconditions(root = repositoryRoot) {
  const manifest = JSON.parse(read('package.json', root))
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  assert.equal(manifest.name, '@heroku-cli/command', 'run from the @heroku-cli/command checkout')
  assert.equal(expectedRepositoryReferences.has(repository), true, 'run from the heroku/heroku-cli-command repository')
  assertExternalSourceActive(root)
  for (const [relativePath, replacements] of rollbackReplacements) {
    const source = read(relativePath, root)
    assert.doesNotMatch(source, /(?:from|import\()\s*['"][^'"]*deprecated\//, `${relativePath} is already rolled back`)
    for (const [before] of replacements) {
      assert.ok(source.includes(before), `${relativePath} must contain the rollback target: ${before}`)
    }
  }
}

function verifyArchiveHashes(root) {
  const baseline = JSON.parse(read(baselinePath, root))
  assert.equal(baseline.schemaVersion, 1)
  assert.equal(baseline.packageVersion, '13.2.0')
  assert.deepEqual(baseline.allowedRelocations, [{
    archived: relocatedPackageLookup,
    baseline: baselinePackageLookup,
    path: 'lib/cli-command-telemetry.ts',
  }])

  const archivedAbsoluteRoot = path.join(root, archivedRoot)
  assert.deepEqual(listFiles(archivedAbsoluteRoot).sort(), baseline.files.map(file => file.path).sort())
  for (const file of baseline.files) {
    const archivedSource = read(path.join(archivedRoot, file.path), root)
    const normalizedSource = archivedSource.replace(relocatedPackageLookup, baselinePackageLookup)
    assert.equal(Buffer.byteLength(normalizedSource), file.bytes, `${file.path} byte length`)
    assert.equal(sha256(normalizedSource), file.sha256, `${file.path} SHA-256`)
    if (file.path === 'lib/cli-command-telemetry.ts') {
      assert.match(archivedSource, /join\(dir, '\.\.\/\.\.\/\.\.\/\.\.\/package\.json'\)/)
      assert.doesNotMatch(archivedSource, /join\(dir, '\.\.\/\.\.\/\.\.\/package\.json'\)/)
    } else {
      assert.equal(archivedSource, normalizedSource, `${file.path} has an undocumented relocation`)
    }
  }

  return baseline.files.length
}

function makeTemporaryCopy(root) {
  for (const entry of copyEntries) {
    const source = path.join(repositoryRoot, entry)
    const destination = path.join(root, entry)
    const stat = fs.lstatSync(source)
    if (stat.isDirectory()) {
      fs.mkdirSync(destination, {recursive: true})
      for (const relativePath of listFiles(source)) {
        const target = path.join(destination, relativePath)
        fs.mkdirSync(path.dirname(target), {recursive: true})
        fs.copyFileSync(path.join(source, relativePath), target, fs.constants.COPYFILE_EXCL)
      }
    } else {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
    }
  }

  for (const forbidden of ['.git', '.npmrc', '.env', 'coverage', 'lib', 'node_modules']) {
    assert.equal(fs.existsSync(path.join(root, forbidden)), false, `${forbidden} must not be copied`)
  }

  assert.equal(sha256(fs.readFileSync(path.join(root, 'package-lock.json'))), sha256(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'))))
}

function applyRollback(root) {
  for (const [relativePath, replacements] of rollbackReplacements) {
    const absolutePath = path.join(root, relativePath)
    let source = fs.readFileSync(absolutePath, 'utf8')
    for (const [before, after] of replacements) {
      assert.ok(source.includes(before), `${relativePath} rollback target drifted: ${before}`)
      source = source.replaceAll(before, after)
    }

    fs.writeFileSync(absolutePath, source)
  }

  // The v14 adapter contains behavior and API additions that did not exist in v13.2.0.
  // During rollback it remains as an active compatibility path but delegates wholly to the archive.
  fs.writeFileSync(path.join(root, 'src/credential-manager-core/lib/credential-manager-adapter.ts'), `export {
  getAuth,
  listKeychainAccounts,
  removeAuth,
  saveAuth,
} from '../../deprecated/credential-manager-core/index.js'
`)

  for (const [relativePath] of rollbackReplacements) {
    const source = read(relativePath, root)
    assert.match(source, /deprecated\/credential-manager-core/, `${relativePath} was not repointed to the archive`)
    assert.doesNotMatch(source, /from '@heroku\/heroku-credential-manager'/, `${relativePath} still imports the external package`)
  }

  const archivedImporters = listFiles(path.join(root, 'src'))
    .filter(relativePath => relativePath.endsWith('.ts') && !relativePath.startsWith('deprecated/'))
    .filter(relativePath => /(?:from|import\()\s*['"][^'"]*deprecated\//.test(read(path.join('src', relativePath), root)))
    .sort()
  assert.deepEqual(archivedImporters, [...rollbackReplacements.keys()].map(relativePath => relativePath.slice(4)).sort())
}

function findExecutable(name) {
  const suffixes = process.platform === 'win32' ? ['', '.cmd', '.exe'] : ['']
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {}
    }
  }

  throw new Error(`${name} was not found on PATH`)
}

function npmInvocation() {
  if (process.env.npm_execpath?.endsWith('.js') && fs.existsSync(process.env.npm_execpath)) {
    return {arguments_: [process.env.npm_execpath], command: process.execPath, directory: path.dirname(process.env.npm_execpath)}
  }

  const npmExecutable = findExecutable('npm')
  const realNpm = fs.realpathSync(npmExecutable)
  if (realNpm.endsWith('.js')) {
    return {arguments_: [realNpm], command: process.execPath, directory: path.dirname(npmExecutable)}
  }

  const npmCli = path.resolve(path.dirname(npmExecutable), '../lib/node_modules/npm/bin/npm-cli.js')
  assert.equal(fs.existsSync(npmCli), true, `npm CLI was not found for ${npmExecutable}`)
  return {arguments_: [npmCli], command: process.execPath, directory: path.dirname(npmExecutable)}
}

async function createConfinedNpmConfig(target, npm) {
  const source = (await run(npm.command, [...npm.arguments_, 'config', 'get', 'userconfig'], {
    env: {PATH: process.env.PATH},
  })).trim()
  let registryLine = 'registry=https://registry.npmjs.org/'
  let npmAuthToken
  if (source && source !== 'undefined' && fs.existsSync(source)) {
    const contents = fs.readFileSync(source, 'utf8')
    const registry = contents.split(/\r?\n/).find(line => /^registry\s*=/.test(line))
    const auth = contents.split(/\r?\n/).find(line => /^\/\/registry\.npmjs\.org\/:_authToken\s*=/.test(line))
    if (registry) registryLine = registry
    if (auth) {
      const rawToken = auth.slice(auth.indexOf('=') + 1).trim()
      const variable = /^\$\{([^}]+)\}$/.exec(rawToken)?.[1]
      npmAuthToken = variable ? process.env[variable] : rawToken
      assert.ok(npmAuthToken && !npmAuthToken.includes('${'), 'npm registry token must resolve before rollback verification')
      confinedSecrets.push(npmAuthToken)
    }
  }

  fs.writeFileSync(target, [registryLine, npmAuthToken && '//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}', 'always-auth=false', ''].filter(Boolean).join('\n'), {mode: 0o600})
  fs.chmodSync(target, 0o600)
  // eslint-disable-next-line no-bitwise
  assert.equal(fs.statSync(target).mode & 0o777, 0o600)
  if (npmAuthToken) {
    assert.match(fs.readFileSync(target, 'utf8'), /_authToken=\$\{NODE_AUTH_TOKEN\}/)
    assert.doesNotMatch(fs.readFileSync(target, 'utf8'), new RegExp(npmAuthToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  return npmAuthToken
}

async function createHermeticEnvironment(root, npm) {
  const home = path.join(root, '.rollback-home')
  const dataDir = path.join(home, '.local', 'share', 'heroku')
  const bin = path.join(root, '.rollback-bin')
  const temp = path.join(root, '.tmp')
  const userConfig = path.join(root, '.rollback-npmrc')
  for (const directory of [bin, dataDir, home, temp]) fs.mkdirSync(directory, {mode: 0o700, recursive: true})
  const npmAuthToken = await createConfinedNpmConfig(userConfig, npm)

  const unixStub = '#!/bin/sh\necho "native credential stores and GPG are disabled in the rollback drill" >&2\nexit 97\n'
  const windowsStub = '@echo off\r\necho native credential stores and GPG are disabled in the rollback drill 1>&2\r\nexit /b 97\r\n'
  if (process.platform === 'win32') {
    for (const command of ['gpg.cmd', 'powershell.cmd', 'secret-tool.cmd', 'security.cmd']) {
      fs.writeFileSync(path.join(bin, command), windowsStub, {mode: 0o700})
    }
  } else {
    for (const command of ['gpg', 'powershell', 'powershell.exe', 'secret-tool', 'security']) {
      fs.writeFileSync(path.join(bin, command), unixStub, {mode: 0o700})
    }
  }

  const executableDirectories = new Set([bin, npm.directory, path.dirname(process.execPath)])
  if (process.platform === 'win32') {
    for (const name of ['SystemRoot', 'WINDIR']) {
      if (process.env[name]) executableDirectories.add(path.join(process.env[name], 'System32'))
    }
  } else {
    executableDirectories.add('/usr/bin')
    executableDirectories.add('/bin')
  }

  const environment = {
    ACCEPTANCE_TESTS: 'true',
    CI: 'true',
    DISABLE_TELEMETRY: 'true',
    GNUPGHOME: path.join(home, '.gnupg-disabled'),
    HEROKU_DATA_DIR: dataDir,
    HEROKU_NETRC_WRITE: 'true',
    HOME: home,
    NODE_ENV: 'test',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_CACHE: path.join(root, '.npm-cache'),
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_USERCONFIG: userConfig,
    PATH: [...executableDirectories].join(path.delimiter),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
  }
  for (const name of ['COMSPEC', 'LANG', 'LC_ALL', 'PATHEXT', 'SystemRoot', 'WINDIR']) {
    if (process.env[name]) environment[name] = process.env[name]
  }

  assert.deepEqual(
    Object.keys(environment).filter(name => /(?:AUTH|KEY|PROXY|SESSION|TOKEN)/i.test(name)),
    [],
    'allowlisted environment contains a credential/proxy variable',
  )
  return {environment, npmAuthToken}
}

async function installDependencies(root, environment, npm, npmAuthToken) {
  try {
    await run(npm.command, [...npm.arguments_, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: root,
      env: npmAuthToken ? {...environment, NODE_AUTH_TOKEN: npmAuthToken} : environment,
    })
    dependencyIsolation = 'npm ci --ignore-scripts from copied package-lock'
  } catch (error) {
    if (!/E404|E401|E403|not in this registry|Unable to authenticate/i.test(String(error))) throw error
    const realDependencies = path.join(repositoryRoot, 'node_modules')
    assert.equal(fs.existsSync(realDependencies), true, 'authenticated npm install failed and no local dependency tree is available')
    const before = treeFingerprint(realDependencies)
    realDependencyFingerprint = before
    copyTree(realDependencies, path.join(root, 'node_modules'))
    assert.equal(treeFingerprint(realDependencies), before, 'real dependency tree changed while it was copied')
    makeTreeReadOnly(path.join(root, 'node_modules'))
    isolatedDependenciesReadOnly = true
    dependencyIsolation = `read-only copied dependency tree; real tree fingerprint ${before}`
  }

  await run(npm.command, [...npm.arguments_, 'ls', '--all', '--json'], {cwd: root, env: environment})

  const sourceLock = JSON.parse(read('package-lock.json', root))
  const installedLock = JSON.parse(read('node_modules/.package-lock.json', root))
  assert.equal(installedLock.lockfileVersion, sourceLock.lockfileVersion)
  for (const [packagePath, metadata] of Object.entries(installedLock.packages)) {
    const expected = sourceLock.packages[packagePath]
    assert.ok(expected, `installed package is absent from copied lockfile: ${packagePath}`)
    for (const field of ['integrity', 'resolved', 'version']) {
      if (metadata[field] !== undefined) assert.equal(metadata[field], expected[field], `${packagePath} ${field}`)
    }
  }

  const manifest = JSON.parse(read('package.json', root))
  for (const name of Object.keys({...manifest.dependencies, ...manifest.devDependencies})) {
    assert.ok(sourceLock.packages[`node_modules/${name}`]?.version, `${name} has no copied lockfile entry`)
    assert.equal(fs.existsSync(path.join(root, 'node_modules', name, 'package.json')), true, `${name} was not installed`)
  }
}

async function buildRollbackCopy(root, environment) {
  const outputRoot = path.join(root, 'lib')
  await run(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    path.join(root, 'tsconfig.json'),
    '--outDir',
    outputRoot,
  ], {cwd: root, env: environment})
  for (const relativePath of rollbackReplacements.keys()) {
    const emittedBase = relativePath.replace(/^src\//, 'lib/').replace(/\.ts$/, '')
    assert.equal(fs.existsSync(path.join(root, `${emittedBase}.js`)), true, `${emittedBase}.js was not emitted`)
    assert.equal(fs.existsSync(path.join(root, `${emittedBase}.d.ts`)), true, `${emittedBase}.d.ts was not emitted`)
  }

  assert.equal(fs.existsSync(path.join(outputRoot, 'deprecated/credential-manager-core/index.js')), true)
}

function writeGeneratedSmoke(root) {
  const generatedRoot = path.join(root, '.rollback-generated')
  fs.mkdirSync(generatedRoot, {mode: 0o700, recursive: true})
  fs.writeFileSync(path.join(generatedRoot, 'runtime-smoke.mjs'), `import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as facade from '../lib/credential-manager.js'
import * as core from '../lib/credential-manager-core/index.js'
import * as adapter from '../lib/credential-manager-core/lib/credential-manager-adapter.js'
import * as selector from '../lib/credential-manager-core/lib/credential-storage-selector.js'
import * as loginState from '../lib/credential-manager-core/lib/login-state.js'
import netrcDefault, * as netrcParser from '../lib/credential-manager-core/lib/netrc-parser.js'
import * as typesModule from '../lib/credential-manager-core/lib/types.js'
import {LinuxHandler} from '../lib/credential-manager-core/credential-handlers/linux-handler.js'
import {MacOSHandler} from '../lib/credential-manager-core/credential-handlers/macos-handler.js'
import {NetrcHandler} from '../lib/credential-manager-core/credential-handlers/netrc-handler.js'
import {WindowsHandler} from '../lib/credential-manager-core/credential-handlers/windows-handler.js'
import * as packageRoot from '../lib/index.js'
import * as archive from '../lib/deprecated/credential-manager-core/index.js'
import * as archiveSelector from '../lib/deprecated/credential-manager-core/lib/credential-storage-selector.js'
import * as archiveLoginState from '../lib/deprecated/credential-manager-core/lib/login-state.js'
import archiveNetrcDefault, * as archiveNetrcParser from '../lib/deprecated/credential-manager-core/lib/netrc-parser.js'

assert.deepEqual(Object.keys(typesModule), [])
for (const name of ['getAuth', 'listKeychainAccounts', 'removeAuth', 'saveAuth']) {
  assert.equal(core[name], archive[name], \`core identity: \${name}\`)
  assert.equal(adapter[name], archive[name], \`adapter identity: \${name}\`)
  assert.equal(packageRoot[name], archive[name], \`package identity: \${name}\`)
}
assert.equal(selector.CredentialStore, archiveSelector.CredentialStore)
assert.equal(selector.getNativeCredentialStore, archiveSelector.getNativeCredentialStore)
assert.equal(selector.getStorageConfig, archiveSelector.getStorageConfig)
assert.equal(loginState.readLoginState, archiveLoginState.readLoginState)
assert.equal(loginState.writeLoginState, archiveLoginState.writeLoginState)
assert.equal(loginState.deleteLoginState, archiveLoginState.deleteLoginState)
assert.equal(netrcParser.Netrc, archiveNetrcParser.Netrc)
assert.equal(netrcParser.parse, archiveNetrcParser.parse)
assert.equal(netrcDefault.constructor, archiveNetrcDefault.constructor)
assert.equal(LinuxHandler, archive.LinuxHandler)
assert.equal(MacOSHandler, archive.MacOSHandler)
assert.equal(NetrcHandler, archive.NetrcHandler)
assert.equal(WindowsHandler, archive.WindowsHandler)
assert.deepEqual(selector.getStorageConfig(), {credentialStore: null, useNetrc: true})

const host = 'rollback-active.test.heroku.com'
const account = 'rollback-active@example.com'
const token = 'rollback-active-token'
await facade.saveAuth(account, token, [host], 'rollback-active-service')
assert.deepEqual(await packageRoot.getAuth(account, host), {account, token})
assert.deepEqual(await core.getAuth(account, host), {account, token})
assert.deepEqual(await adapter.getAuth(account, host), {account, token})
assert.deepEqual(await packageRoot.listKeychainAccounts(), [])
await facade.removeAuth(account, [host])
await assert.rejects(core.getAuth(account, host), /No auth found/)

const explicitNetrc = path.join(process.env.HOME, 'handler.netrc')
const handler = new NetrcHandler(explicitNetrc)
await handler.saveAuthForHosts({login: account, password: token}, [host])
assert.deepEqual(await handler.getAuth(host), {login: account, password: token})
await handler.removeAuthForHosts([host])
await assert.rejects(handler.getAuth(host), /No auth found/)

const parsed = netrcParser.parse(\`machine \${host} login \${account} password \${token}\`)
assert.equal(parsed[host].password, token)
const explicitParserNetrc = new netrcParser.Netrc(path.join(process.env.HOME, 'parser.netrc'))
explicitParserNetrc.machines = parsed
await explicitParserNetrc.save()
await explicitParserNetrc.load()
assert.equal(explicitParserNetrc.machines[host].login, account)

const dataDir = process.env.HEROKU_DATA_DIR
await loginState.writeLoginState(dataDir, account)
assert.deepEqual(await loginState.readLoginState(dataDir), {account})
await loginState.deleteLoginState(dataDir)
assert.equal(fs.existsSync(path.join(dataDir, 'login.json')), false)

console.log('active runtime smoke passed: 12 transformed paths, facade operations, handlers, selector, login-state, and netrc')
`)

  const declarationImports = [...rollbackReplacements.keys()]
    .map(relativePath => `import * as p${Math.random().toString(36).slice(2)} from '../${relativePath.replace(/^src\//, 'lib/').replace(/\.ts$/, '.js')}'`)
    .join('\n')
  fs.writeFileSync(path.join(generatedRoot, 'declaration-smoke.ts'), `${declarationImports}
import type {AuthEntry as CoreAuthEntry} from '../lib/credential-manager-core/lib/types.js'
import type {AuthEntry as RootAuthEntry} from '../lib/index.js'

const coreEntry: CoreAuthEntry = {account: undefined, token: undefined}
const rootEntry: RootAuthEntry = coreEntry
void rootEntry
`)
}

async function runGeneratedSmoke(root, environment) {
  writeGeneratedSmoke(root)
  await run(process.execPath, [path.join(root, '.rollback-generated/runtime-smoke.mjs')], {
    cwd: root,
    env: environment,
    printOutput: true,
  })
  await run(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    // TypeScript 6 errors (TS5112) when files are passed on the command line
    // while a tsconfig.json is present; this generated smoke file is compiled
    // in isolation with explicit flags, so ignore the repo config.
    '--ignoreConfig',
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--target',
    'es2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    path.join(root, '.rollback-generated/declaration-smoke.ts'),
  ], {cwd: root, env: environment})
}

async function proveTelemetryPackageLookup(root) {
  const telemetryPath = path.join(root, 'lib/deprecated/credential-manager-core/lib/cli-command-telemetry.js')
  assert.match(fs.readFileSync(telemetryPath, 'utf8'), /join\(dir, '\.\.\/\.\.\/\.\.\/\.\.\/package\.json'\)/)
  const telemetry = await import(`${pathToFileURL(telemetryPath).href}?rollback-drill=${Date.now()}`)
  let initialization
  telemetry.credentialSentrySdk.getClient = function () {}
  telemetry.credentialSentrySdk.init = settings => {
    initialization = settings
    return {async close() {}}
  }

  telemetry.credentialSentrySdk.captureException = function () {}
  telemetry.credentialSentrySdk.flush = async () => true

  const saved = {CI: process.env.CI, DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY, NODE_ENV: process.env.NODE_ENV}
  try {
    delete process.env.CI
    delete process.env.DISABLE_TELEMETRY
    process.env.NODE_ENV = 'rollback-drill'
    await telemetry.reportCredentialStoreError(new Error('rollback telemetry lookup probe'), {
      credentialStore: 'macos-keychain',
      operation: 'getAuth',
    })
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  const packageMetadata = JSON.parse(read('package.json', root))
  assert.equal(initialization?.release, `${packageMetadata.name}@${packageMetadata.version}`)
}

async function runSupplementalTests(root, environment) {
  const mocha = path.join(root, 'node_modules/mocha/bin/mocha.js')
  await run(process.execPath, [mocha, '--forbid-only', ...focusedTests], {
    cwd: root,
    env: environment,
    printOutput: true,
  })
  await run(process.execPath, [
    mocha,
    '--forbid-only',
    '--grep',
    String.raw`^credential-manager acceptance \.netrc only`,
    'test/credential-manager/acceptance/index.acceptance.test.ts',
  ], {cwd: root, env: environment, printOutput: true})
}

async function selfTestGuards() {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${rollbackPrefix}guard-test-`))
  try {
    makeTemporaryCopy(probeRoot)
    assertNegativePreconditions(probeRoot)
    const manifestPath = path.join(probeRoot, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    fs.writeFileSync(manifestPath, JSON.stringify({...manifest, repository: 'github:heroku/heroku-cli-command'}))
    assertNegativePreconditions(probeRoot)
    fs.writeFileSync(manifestPath, JSON.stringify({...manifest, repository: 'https://evil.example/github.com/heroku/heroku-cli-command.git'}))
    assert.throws(() => assertNegativePreconditions(probeRoot), /heroku\/heroku-cli-command repository/)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    const targetPath = [...rollbackReplacements.keys()][0]
    const [rollbackTarget] = rollbackReplacements.get(targetPath)[0]
    fs.writeFileSync(path.join(probeRoot, targetPath), read(targetPath, probeRoot).replace(rollbackTarget, 'rollback-target-drifted'))
    assert.throws(() => applyRollback(probeRoot), /rollback target drifted/)

    fs.rmSync(probeRoot, {force: true, recursive: true})
    fs.mkdirSync(probeRoot)
    makeTemporaryCopy(probeRoot)
    fs.appendFileSync(path.join(probeRoot, archivedRoot, 'index.ts'), '\n// guard self-test mutation\n')
    assert.throws(() => verifyArchiveHashes(probeRoot), /byte length|SHA-256/)
  } finally {
    fs.rmSync(probeRoot, {force: true, recursive: true})
  }

  console.log('Credential-manager rollback guard self-test passed (arbitrary checkout name accepted; wiring drift and archive tamper rejected).')
}

async function waitForMarker(marker) {
  const deadline = Date.now() + 15_000
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) return fs.readFileSync(marker, 'utf8')
    await new Promise(resolve => {
      setTimeout(resolve, 25)
    })
  }
  /* eslint-enable no-await-in-loop */

  throw new Error(`timed out waiting for cleanup self-test marker: ${marker}`)
}

function startSelfTest(arguments_) {
  let child
  const completion = new Promise((resolve, reject) => {
    child = spawn(process.execPath, [scriptPath, ...arguments_], {
      cwd: repositoryRoot,
      env: {PATH: process.env.PATH},
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({code, signal, stderr}))
  })
  return {child, completion}
}

async function selfTestCleanup() {
  const selfTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${rollbackPrefix}cleanup-test-`))
  try {
    /* eslint-disable no-await-in-loop */
    for (const signal of supportedSignals) {
      const marker = path.join(selfTestRoot, `${signal}.marker`)
      const {child, completion} = startSelfTest([`--internal-hold-marker=${marker}`])
      const childRoot = await waitForMarker(marker)
      child.kill(signal)
      const result = await completion
      assert.equal(result.code, signalExitCodes[signal], `${signal} conventional exit code: ${result.stderr}`)
      assert.equal(result.signal, null, `${signal} should be handled before exit`)
      assert.equal(fs.existsSync(childRoot), false, `${signal} left temporary rollback copy behind`)
    }
    /* eslint-enable no-await-in-loop */

    const failureMarker = path.join(selfTestRoot, 'failure.marker')
    const {completion} = startSelfTest([`--internal-failure-marker=${failureMarker}`])
    const failureRoot = await waitForMarker(failureMarker)
    const failure = await completion
    assert.notEqual(failure.code, 0)
    assert.equal(fs.existsSync(failureRoot), false, 'failure path left temporary rollback copy behind')
  } finally {
    fs.rmSync(selfTestRoot, {force: true, recursive: true})
  }

  const matrixNote = process.platform === 'win32'
    ? ' SIGHUP requires the remote POSIX matrix.'
    : ' SIGHUP, SIGINT, and SIGTERM were verified locally.'
  console.log(`Credential-manager rollback cleanup self-test passed (failure and signals).${matrixNote}`)
}

async function internalCleanupProbe(marker, fail) {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${rollbackPrefix}probe-`))
  fs.writeFileSync(path.join(temporaryRoot, 'probe'), 'cleanup probe')
  fs.writeFileSync(marker, temporaryRoot)
  if (fail) throw new Error('intentional cleanup self-test failure')
  await new Promise(() => {
    setInterval(() => {}, 1000)
  })
}

async function runDrill() {
  assertNegativePreconditions()
  const repositoryStateBefore = await captureRepositoryState()
  const archiveFileCount = verifyArchiveHashes(repositoryRoot)
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), rollbackPrefix))
  console.log('Rollback drill: preparing isolated temporary copy...')
  makeTemporaryCopy(temporaryRoot)
  applyRollback(temporaryRoot)
  assert.equal(verifyArchiveHashes(temporaryRoot), archiveFileCount)

  const npm = npmInvocation()
  const {environment, npmAuthToken} = await createHermeticEnvironment(temporaryRoot, npm)
  console.log('Rollback drill: installing copied lockfile with npm ci --ignore-scripts...')
  await installDependencies(temporaryRoot, environment, npm, npmAuthToken)
  console.log('Rollback drill: building and running active-path smoke...')
  await buildRollbackCopy(temporaryRoot, environment)
  await runGeneratedSmoke(temporaryRoot, environment)
  await proveTelemetryPackageLookup(temporaryRoot)
  console.log('Rollback drill: running supplemental storage and acceptance tests...')
  await runSupplementalTests(temporaryRoot, environment)

  assertExternalSourceActive()
  assert.equal(await captureRepositoryState(), repositoryStateBefore, 'tracked/staged/untracked Git state changed during the drill')
  if (realDependencyFingerprint) {
    assert.equal(
      treeFingerprint(path.join(repositoryRoot, 'node_modules')),
      realDependencyFingerprint,
      'real dependency tree changed during the drill',
    )
  }

  cleanupTemporaryRoot()

  console.log('\nCredential-manager rollback drill passed.')
  console.log(`- Active rollback proof: ${rollbackReplacements.size} transformed active runtime/declaration paths loaded; identities and storage operations passed.`)
  console.log(`- Archived source: ${archiveFileCount} v13.2.0 files matched SHA-256/byte baselines; telemetry lookup was the only relocation.`)
  console.log(`- Dependencies: copied package-lock matched byte-for-byte; ${dependencyIsolation}; installed lock entries match it.`)
  console.log(`- Supplemental tests: ${focusedTests.length} storage files plus the hermetic netrc acceptance suite passed.`)
  const isolationSummary = '- Isolation: only an allowlisted environment was passed; credential/session/proxy variables were absent; '
    + 'HOME, USERPROFILE, XDG, TMP, PATH, npm config/cache, native stores, and GPG were isolated.'
  console.log(isolationSummary)
  console.log('- Cleanup: the temporary copy was removed; failure/signal behavior is covered by --self-test-cleanup.')
  console.log('- Platform-dependent native credential-store and GPG success paths were not invoked; Windows behavior still requires its remote matrix.')
  console.log('- Real tree: external-package source remained active; tracked, staged, and untracked Git state fingerprint was unchanged. Ignored files were not fingerprinted or shared.')
}

async function main() {
  if (options['internal-hold-marker']) return internalCleanupProbe(options['internal-hold-marker'], false)
  if (options['internal-failure-marker']) return internalCleanupProbe(options['internal-failure-marker'], true)
  if (options['self-test-guards']) return selfTestGuards()
  if (options['self-test-cleanup']) return selfTestCleanup()
  return runDrill()
}

try {
  await main()
} catch (error) {
  console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error)))
  process.exitCode = 1
} finally {
  cleanupTemporaryRoot()
}
