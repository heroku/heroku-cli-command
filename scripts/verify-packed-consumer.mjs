#!/usr/bin/env node

import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {dirname, join, relative, resolve, sep} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {promisify} from 'node:util'
import {parseArgs} from 'node:util'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = fileURLToPath(import.meta.url)
const npmCliPath = process.env.PACKED_VERIFY_NPM_CLI
const workspacePrefix = 'heroku-command-packed-'
const {values: options} = parseArgs({
  options: {'baseline-sha': {type: 'string'}},
  strict: true,
})
const authoritativeBaselinePath = join(repositoryRoot, '.github', 'packed-consumer-baseline')
const authoritativeBaselineSha = (await readFile(authoritativeBaselinePath, 'utf8')).trim()
const requestedBaselineSha = options['baseline-sha'] ?? process.env.PACKED_CONSUMER_BASELINE_SHA
const baselineSha = authoritativeBaselineSha
const expectedDependencies = new Map([
  ['@heroku/heroku-credential-manager', {
    integrity: 'sha512-jonzLCL5kt79oL3TZYxFsJ9d7eO6ZrGJmsjDkAjDb4CNFvC72DH5Ke6xZ+G9iN5HgQ36Y7Mji+V5h+QS0bEj/Q==',
    tarball: 'https://registry.npmjs.org/@heroku/heroku-credential-manager/-/heroku-credential-manager-0.1.0.tgz',
    version: '0.1.0',
  }],
  ['@heroku/http-call', {
    integrity: 'sha512-FOOV9oK+kvcWu1KgBSdPBDS1b7dPeQORi/6IEC3Q7uNDhU7zhNR0fh5+p5p1BFMG/CmH2XNwbOeAL6YqmCrX1Q==',
    tarball: 'https://registry.npmjs.org/@heroku/http-call/-/http-call-5.5.2.tgz',
    version: '5.5.2',
  }],
])
const expectedCompatibilityPaths = new Set([
  'lib/credential-manager-core/credential-handlers/linux-handler.js',
  'lib/credential-manager-core/credential-handlers/macos-handler.js',
  'lib/credential-manager-core/credential-handlers/netrc-handler.js',
  'lib/credential-manager-core/credential-handlers/windows-handler.js',
  'lib/credential-manager-core/index.js',
  'lib/credential-manager-core/lib/cli-command-telemetry.js',
  'lib/credential-manager-core/lib/credential-storage-selector.js',
  'lib/credential-manager-core/lib/login-state.js',
  'lib/credential-manager-core/lib/netrc-parser.js',
  'lib/credential-manager-core/lib/types.js',
])
const intentionalAdditions = new Set([
  'lib/credential-manager-core/lib/credential-manager-adapter.d.ts',
  'lib/credential-manager-core/lib/credential-manager-adapter.js',
  'lib/credential-manager-login-adapters.d.ts',
  'lib/credential-manager-login-adapters.js',
  'lib/login-state-coordinator.d.ts',
  'lib/login-state-coordinator.js',
])
const intentionalPackageAdditions = new Set(['@heroku/heroku-credential-manager'])
const sensitivePathPattern = /(^|\/)(?:\.npmrc|npmrc|npm-cache|\.npm|cache|logs?|_logs?)(?:\/|$)|(?:^|\/)(?:[^/]*(?:token|userconfig)[^/]*)$|heroku-credential-manager[^/]*\.tgz$/i
const safeEnvironmentNames = new Set([
  'ALL_PROXY',
  'CI',
  'ComSpec',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'NO_PROXY',
  'PATH',
  'PACKED_VERIFY_NPM_CLI',
  'PACKED_VERIFY_SKIP_MUTATIONS',
  'PATHEXT',
  'SystemDrive',
  'SystemRoot',
  'TERM',
  'WINDIR',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
])

let workspace
let currentPhase = 'initialization'
let pacote
let npmTarContents
let npmTar
let npmPacklist

function fail(message) {
  throw new Error(`[${currentPhase}] ${message}`)
}

function check(condition, message) {
  if (!condition) fail(message)
}

function normalizePath(path) {
  return path.split(sep).join('/')
}

function parseJsonOutput(output, label) {
  const starts = [output.indexOf('['), output.indexOf('{')].filter(index => index >= 0)
  check(starts.length > 0, `${label} did not produce JSON`)
  const start = Math.min(...starts)
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < output.length; index++) {
    const character = output[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }

    if (character === '"') inString = true
    else if (character === '[' || character === '{') depth++
    else if (character === ']' || character === '}') {
      depth--
      if (depth === 0) return JSON.parse(output.slice(start, index + 1))
    }
  }

  fail(`${label} JSON was incomplete`)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function walk(path, root = path) {
  const entries = await readdir(path, {withFileTypes: true})
  const files = []
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) files.push(...await walk(entryPath, root))
    else files.push(normalizePath(relative(root, entryPath)))
  }

  return files.sort()
}

function redactionVariants(value) {
  if (!value || value.length < 4) return []
  const variants = new Set([value])
  try {
    variants.add(encodeURIComponent(value))
    variants.add(Buffer.from(value).toString('base64'))
    variants.add(Buffer.from(value).toString('base64url'))
  } catch {}
  return [...variants].filter(Boolean)
}

function redact(value) {
  let redacted = String(value)
  for (const secret of workspace?.redactions ?? []) redacted = redacted.replaceAll(secret, '[redacted]')
  return redacted
    .replace(/((?:_authToken|_auth|password)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
}

function sanitizedEnvironment(overrides = {}) {
  const environment = {}
  for (const name of safeEnvironmentNames) {
    if (process.env[name] !== undefined) environment[name] = process.env[name]
  }

  return {...environment, ...overrides}
}

async function run(command, args, options = {}) {
  const printableCommand = options.label ?? `${command} ${args.join(' ')}`
  try {
    return await execFileAsync(command, args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: workspace?.baseEnvironment ?? sanitizedEnvironment(),
      maxBuffer: 20 * 1024 * 1024,
      ...options,
      label: undefined,
    })
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
    const stdout = typeof error.stdout === 'string' ? error.stdout.trim() : ''
    throw new Error(`${printableCommand} failed: ${redact(stderr || stdout || error.message)}`)
  }
}

function resolveConfigEnvironment(value, environment, key) {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    check(Object.hasOwn(environment, name), `npm config ${key} references unavailable environment variable ${name}`)
    return environment[name]
  })
}

async function createMinimalNpmConfig(target) {
  const userConfig = process.env.npm_config_userconfig || process.env.NPM_CONFIG_USERCONFIG
  const configPath = userConfig || (process.env.HOME ? join(process.env.HOME, '.npmrc') : undefined)
  const lines = configPath ? (await readFile(configPath, 'utf8').catch(() => '')).split(/\r?\n/) : []
  const output = ['registry=https://registry.npmjs.org/']
  const childEnvironment = {}
  let secretIndex = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 1) continue
    const key = trimmed.slice(0, separator).trim()
    const rawValue = trimmed.slice(separator + 1).trim()
    const relevant = key === 'registry' || key.endsWith(':registry') || /(?:_authToken|_auth|username|password|always-auth)$/i.test(key)
    if (!relevant) continue
    const resolved = resolveConfigEnvironment(rawValue, process.env, key)
    if (/(?:_authToken|_auth|password)$/i.test(key)) {
      const name = `PACKED_VERIFY_NPM_SECRET_${secretIndex++}`
      childEnvironment[name] = resolved
      output.push(`${key}=\${${name}}`)
      for (const variant of redactionVariants(resolved)) workspace.redactions.add(variant)
    } else {
      output.push(`${key}=${resolved}`)
    }
  }

  await writeFile(target, `${output.join('\n')}\n`, {mode: 0o600})
  await chmod(target, 0o600)
  return childEnvironment
}

function specifiersFromSource(source, fileName) {
  const scriptKind = fileName.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind)
  const specifiers = new Set()
  const createRequireFactories = new Set()
  const requireAliases = new Set(['require'])

  function addLiteral(node) {
    if (ts.isStringLiteralLike(node)) specifiers.add(node.text)
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) addLiteral(node.moduleSpecifier)
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          if ((element.propertyName ?? element.name).text === 'createRequire') createRequireFactories.add(element.name.text)
        }
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addLiteral(node.moduleReference.expression)
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && createRequireFactories.has(node.initializer.expression.text)) {
      requireAliases.add(node.name.text)
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addLiteral(node.arguments[0])
      else if (ts.isIdentifier(node.expression) && requireAliases.has(node.expression.text)) addLiteral(node.arguments[0])
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

function runSelfChecks() {
  const fixture = `
    import {createRequire as makeRequire} from 'node:module'
    export {thing} from './exported.js'
    const load = makeRequire(import.meta.url)
    load('@heroku/http-call/lib/proxy.js')
    require('./legacy.cjs')
    import('./dynamic.js')
  `
  assert.deepEqual([...specifiersFromSource(fixture, 'fixture.js')].sort(), [
    './dynamic.js',
    './exported.js',
    './legacy.cjs',
    '@heroku/http-call/lib/proxy.js',
    'node:module',
  ])
  assert.throws(() => check(undefined, 'authoritative baseline failed'), /authoritative baseline failed/)
  assert.match('LoginHttpLegacy', /\bLoginHttp\w*/)
}

async function runMutationChecks() {
  const source = await readFile(scriptPath, 'utf8')
  const baselineAnchor = [
    '  const baseline = await packOriginBaseline(baselinePackDirectory)',
    ' // MUTATION_ANCHOR_AUTHORITATIVE_BASELINE',
  ].join('')
  const proxyAnchor = [
    "  check(graph.externalSpecifiers.has('@heroku/http-call/lib/proxy.js'), ",
    "'reachable AST graph/package resolution missing @heroku/http-call/lib/proxy.js') // MUTATION_ANCHOR_PROXY_GRAPH",
  ].join('')

  function mutateUnique(anchor, replacement, label) {
    const occurrences = source.split(anchor).length - 1
    check(occurrences === 1, `${label} mutation anchor occurrence count was ${occurrences}, expected 1`)
    const mutated = source.replace(anchor, replacement)
    check(mutated !== source && mutated.includes(replacement), `${label} mutation did not replace its exact production target`)
    return mutated
  }

  function mutationOutput(error) {
    return `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.trim()
  }

  function assertIntendedFailure(error, expected, label) {
    check(error?.code !== 0, `${label} mutation did not fail the verifier`)
    const output = mutationOutput(error)
    check(!/SyntaxError/.test(output), `${label} mutation failed with SyntaxError instead of its intended assertion`)
    check(!/Cannot find module ['"]typescript['"]|ERR_MODULE_NOT_FOUND[^\n]*typescript/i.test(output), `${label} mutation could not resolve TypeScript`)
    check(output.includes(expected), `${label} mutation output did not contain expected failure: ${expected}\nActual mutation output:\n${redact(output)}`)
    return expected
  }

  async function runMutation(kind, contents) {
    const mutationPath = join(dirname(scriptPath), `.verify-packed-${kind}-${process.pid}-${randomUUID()}.mjs`)
    await writeFile(mutationPath, contents)
    try {
      return await execFileAsync(process.execPath, [mutationPath], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: sanitizedEnvironment({
          HOME: process.env.HOME,
          NPM_CONFIG_CACHE: process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE,
          PACKED_VERIFY_NPM_CLI: npmCliPath,
          PACKED_CONSUMER_BASELINE_SHA: baselineSha,
          PACKED_VERIFY_SKIP_MUTATIONS: '1',
          USERPROFILE: process.env.USERPROFILE ?? process.env.HOME,
        }),
      }).then(() => undefined, error => error)
    } finally {
      await rm(mutationPath, {force: true})
    }
  }

  const baselineExpected = 'Packed command consumer verification failed: self-test baseline failure'
  const baselineMutation = mutateUnique(
    baselineAnchor,
    "  throw new Error('self-test baseline failure') // MUTATED_AUTHORITATIVE_BASELINE",
    'baseline-failure',
  )
  const baselineFailure = await runMutation('baseline', baselineMutation)
  const baselineEvidence = assertIntendedFailure(baselineFailure, baselineExpected, 'baseline-failure')

  const proxyExpected = 'Packed command consumer verification failed: [TypeScript AST reachable graph] reachable AST graph/package resolution missing @heroku/http-call/lib/proxy.js'
  const proxyMutation = mutateUnique(
    proxyAnchor,
    "  check(graph.externalSpecifiers.has('@heroku/http-call/lib/missing-proxy.js'), 'reachable AST graph/package resolution missing @heroku/http-call/lib/proxy.js') // MUTATED_PROXY_GRAPH",
    'proxy/createRequire',
  )
  const proxyFailure = await runMutation('proxy', proxyMutation)
  const proxyEvidence = assertIntendedFailure(proxyFailure, proxyExpected, 'proxy/createRequire')
  workspace.mutationEvidence = {baseline: baselineEvidence, proxy: proxyEvidence}
}

function moduleCandidates(fromFile, specifier) {
  const base = normalizePath(relative(workspace.packageRoot, resolve(dirname(fromFile), specifier)))
  if (fromFile.endsWith('.d.ts')) {
    const declarationBase = base.endsWith('.js') ? `${base.slice(0, -3)}.d.ts` : `${base}.d.ts`
    return [declarationBase, base, `${base}/index.d.ts`, `${base}/index.js`]
  }

  return [base, `${base}.js`, `${base}.cjs`, `${base}/index.js`, `${base}/index.cjs`]
}

async function inspectReachableGraph(entryPaths, fileSet) {
  const pending = [...entryPaths]
  const visited = new Set()
  const externalSpecifiers = new Set()
  while (pending.length > 0) {
    const relativePath = pending.pop()
    if (visited.has(relativePath)) continue
    visited.add(relativePath)
    const absolutePath = join(workspace.packageRoot, relativePath)
    const source = await readFile(absolutePath, 'utf8')
    const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, relativePath.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
    function inspectSymbols(node) {
      if (ts.isIdentifier(node)) check(!node.text.startsWith('LoginHttp'), `found removed LoginHttp* symbol in ${relativePath}`)
      ts.forEachChild(node, inspectSymbols)
    }
    inspectSymbols(sourceFile)

    for (const specifier of specifiersFromSource(source, relativePath)) {
      check(!specifier.includes('/deprecated'), `active import reaches deprecated code from ${relativePath}`)
      if (!specifier.startsWith('.')) {
        externalSpecifiers.add(specifier)
        continue
      }

      const candidates = moduleCandidates(absolutePath, specifier)
      const target = candidates.find(candidate => fileSet.has(candidate))
      check(target, `active import ${specifier} from ${relativePath} does not resolve inside the package`)
      pending.push(target)
    }
  }

  return {externalSpecifiers, visited}
}

async function copyBaseline(destination) {
  const {stdout} = await run('git', ['ls-tree', '-r', '-z', '--name-only', baselineSha], {env: workspace.baseEnvironment})
  const paths = stdout.split('\0').filter(Boolean)
  check(paths.length > 0, `baseline ${baselineSha} archive is empty`)
  for (const path of paths) {
    const target = join(destination, ...path.split('/'))
    await mkdir(dirname(target), {recursive: true})
    const {stdout: contents} = await run('git', ['show', `${baselineSha}:${path}`], {encoding: 'buffer', env: workspace.baseEnvironment})
    await writeFile(target, contents)
  }
}

function isolatedPaths(name) {
  const root = join(workspace.root, name)
  return {
    cache: join(root, 'cache'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    home: join(root, 'home'),
    logs: join(root, 'logs'),
    root,
    temporary: join(root, 'tmp'),
  }
}

async function createIsolatedEnvironment(name, extra = {}) {
  const paths = isolatedPaths(name)
  await Promise.all(Object.values(paths).map(path => mkdir(path, {recursive: true})))
  const environment = sanitizedEnvironment({
    HOME: paths.home,
    TMP: paths.temporary,
    TEMP: paths.temporary,
    TMPDIR: paths.temporary,
    USERPROFILE: paths.home,
    XDG_CACHE_HOME: paths.cache,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    npm_config_cache: paths.cache,
    npm_config_ignore_scripts: 'true',
    npm_config_logs_dir: paths.logs,
    npm_config_userconfig: workspace.npmUserConfig,
    ...workspace.npmEnvironment,
    ...extra,
  })
  return {environment, paths}
}

async function npmPack(directory, packDirectory, environment, label) {
  const manifest = await readJson(join(directory, 'package.json'))
  const previousEnvironment = process.env
  try {
    process.env = environment
    const tree = await new workspace.Arborist({path: directory}).loadActual()
    const files = await npmPacklist(tree, {path: directory})
    const chunks = []
    const tarOptions = {...pacote.DirFetcher.tarCreateOptions(manifest), cwd: directory}
    for await (const chunk of npmTar.c(tarOptions, files)) chunks.push(chunk)
    const tarball = Buffer.concat(chunks)
    let timeout
    const timeoutFailure = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('tarball metadata inspection timed out')), 30_000)
      timeout.unref()
    })
    const metadata = await Promise.race([
      npmTarContents.getContents({...manifest, _id: `${manifest.name}@${manifest.version}`}, tarball),
      timeoutFailure,
    ]).finally(() => clearTimeout(timeout))
    await writeFile(join(packDirectory, metadata.filename), tarball)
    return metadata
  } catch (error) {
    throw new Error(`${label} failed: ${redact(error.message)}`)
  } finally {
    process.env = previousEnvironment
  }
}

async function packCurrentSource(packDirectory) {
  const isolated = await createIsolatedEnvironment('current-build')
  await run(process.execPath, [join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '--project', join(repositoryRoot, 'tsconfig.json'), '--outDir', join(workspace.root, 'current-lib')], {
    cwd: repositoryRoot,
    env: isolated.environment,
    label: 'sanitized current TypeScript build',
  })
  const packageRoot = join(workspace.root, 'current-package')
  await mkdir(packageRoot)
  for (const name of ['LICENSE.md', 'README.md', 'package.json']) await cp(join(repositoryRoot, name), join(packageRoot, name))
  await cp(join(workspace.root, 'current-lib'), join(packageRoot, 'lib'), {recursive: true})
  return npmPack(packageRoot, packDirectory, isolated.environment, 'current npm pack --ignore-scripts')
}

async function packOriginBaseline(packDirectory) {
  const baselineRepository = join(workspace.root, 'baseline-source')
  await mkdir(baselineRepository)
  await copyBaseline(baselineRepository)
  const baselineManifest = await readJson(join(baselineRepository, 'package.json'))
  const isolated = await createIsolatedEnvironment('baseline-build')
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: baselineRepository,
    env: isolated.environment,
    label: `authoritative ${baselineSha} npm ci --ignore-scripts`,
  })
  await run(process.execPath, [join(baselineRepository, 'node_modules/typescript/bin/tsc'), '--project', join(baselineRepository, 'tsconfig.json')], {
    cwd: baselineRepository,
    env: sanitizedEnvironment({...isolated.environment, npm_config_userconfig: undefined, ...Object.fromEntries(Object.keys(workspace.npmEnvironment).map(key => [key, undefined]))}),
    label: `token-free ${baselineSha} TypeScript build`,
  })
  const metadata = await npmPack(baselineRepository, packDirectory, isolated.environment, `authoritative ${baselineSha} npm pack --ignore-scripts`)
  return {manifest: baselineManifest, metadata}
}

async function extractTarball(tarball, destination) {
  await pacote.extract(tarball, destination, {cache: workspace.controlPaths.cache, preferOffline: true})
}

async function verifyPackManifest(packMetadata, baseline) {
  const paths = packMetadata.files.map(file => file.path).sort()
  const pathSet = new Set(paths)
  check(pathSet.has('package.json'), 'packed manifest is missing package.json')
  check(pathSet.has('lib/index.js') && pathSet.has('lib/index.d.ts'), 'packed manifest is missing package root artifacts')
  for (const compatibilityPath of expectedCompatibilityPaths) check(pathSet.has(compatibilityPath), `packed manifest lost compatibility path ${compatibilityPath}`)
  check(!paths.some(path => path.startsWith('lib/deprecated/')), 'packed manifest contains lib/deprecated files')
  check(!paths.some(path => sensitivePathPattern.test(path)), 'packed manifest contains a sensitive config/cache/log/token/private tarball path')

  const baselinePaths = new Set(baseline.metadata.files.map(file => file.path))
  const added = paths.filter(path => !baselinePaths.has(path))
  check(added.every(path => intentionalAdditions.has(path)), `unexpected files added versus baseline: ${added.filter(path => !intentionalAdditions.has(path)).join(', ')}`)
  const missingBaselineJs = [...baselinePaths].filter(path => path.endsWith('.js') && path.startsWith('lib/credential-manager-core/') && !pathSet.has(path))
  check(missingBaselineJs.length === 0, `historical credential-manager JS paths removed versus baseline: ${missingBaselineJs.join(', ')}`)

  const currentDependencies = (await readJson(join(workspace.packageRoot, 'package.json'))).dependencies ?? {}
  const baselineDependencies = baseline.manifest.dependencies ?? {}
  const addedDependencies = Object.keys(currentDependencies).filter(name => !(name in baselineDependencies))
  const removedDependencies = Object.keys(baselineDependencies).filter(name => !(name in currentDependencies))
  const changedDependencies = Object.keys(currentDependencies).filter(name => name in baselineDependencies && currentDependencies[name] !== baselineDependencies[name])
  check(addedDependencies.every(name => intentionalPackageAdditions.has(name)), `unexpected dependencies added versus baseline: ${addedDependencies.join(', ')}`)
  check(removedDependencies.length === 0, `dependencies removed versus baseline: ${removedDependencies.join(', ')}`)
  check(changedDependencies.every(name => name === '@heroku/http-call'), `unexpected dependency ranges changed versus baseline: ${changedDependencies.join(', ')}`)
  check(currentDependencies['@heroku/http-call'] === expectedDependencies.get('@heroku/http-call').version, '@heroku/http-call baseline range did not change to the required exact version')
  return {added, paths}
}

async function resolvePackageManifest(name, commandRequire) {
  const entry = commandRequire.resolve(name)
  let directory = dirname(entry)
  while (true) {
    const manifestPath = join(directory, 'package.json')
    try {
      const manifest = await readJson(manifestPath)
      if (manifest.name === name) return {directory, manifest, manifestPath}
    } catch {}
    const parent = dirname(directory)
    check(parent !== directory, `could not resolve package manifest for ${name}`)
    directory = parent
  }
}

async function verifyInstalledGraph(commandDirectory) {
  const commandRequire = createRequire(join(commandDirectory, 'package.json'))
  for (const [name, artifact] of expectedDependencies) {
    const installed = await resolvePackageManifest(name, commandRequire)
    assert.equal(installed.manifest.version, artifact.version, `${name} installed version mismatch`)
    const lockfile = await readJson(join(workspace.consumerDirectory, 'package-lock.json'))
    const directLockKey = normalizePath(relative(workspace.consumerDirectory, installed.directory))
    const entry = lockfile.packages?.[directLockKey] ?? Object.entries(lockfile.packages ?? {})
      .find(([key, candidate]) => (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) && candidate.version === installed.manifest.version)?.[1]
    check(entry, `${name} resolved package has no matching consumer lockfile entry`)
    assert.equal(entry.version, artifact.version, `${name} lockfile version mismatch`)
    assert.equal(entry.integrity, artifact.integrity, `${name} registry integrity mismatch`)
    assert.equal(entry.resolved, artifact.tarball, `${name} registry tarball mismatch`)
  }

  const proxyPath = commandRequire.resolve('@heroku/http-call/lib/proxy.js')
  const proxy = commandRequire(proxyPath)
  check(typeof proxy.default?.agent === 'function', '@heroku/http-call/lib/proxy.js did not load expected default export')
}

async function snapshotOutsideWorkspace() {
  const roots = [workspace.consumerPaths.home, workspace.consumerPaths.config]
  return new Map((await Promise.all(roots.map(async root => [root, await walk(root)]))).map(([root, files]) => [root, files]))
}

async function writeConsumerFiles(consumerDirectory, commandDirectory, deepPaths, loopbackUrl) {
  const runtimeImports = [
    pathToFileURL(join(commandDirectory, 'lib/index.js')).href,
    pathToFileURL(join(commandDirectory, 'lib/login.js')).href,
    pathToFileURL(join(commandDirectory, 'lib/credential-manager.js')).href,
    pathToFileURL(join(commandDirectory, 'lib/credential-manager-login-adapters.js')).href,
    ...deepPaths.map(path => pathToFileURL(join(commandDirectory, path)).href),
  ]
  await writeFile(join(consumerDirectory, 'smoke.mjs'), `
const modules = await Promise.all(${JSON.stringify(runtimeImports)}.map(specifier => import(specifier)))
const [root, login, credentials, adapters] = modules
if (typeof root.Command !== 'function' || typeof root.APIClient !== 'function') throw new Error('package root runtime shape is incomplete')
if (typeof login.Login !== 'function') throw new Error('login runtime shape is incomplete')
const calls = []
credentials.setCredentialManagerProvider({
  async getAuth(account, host, service) { calls.push(['get', account, host, service]); return {account: 'smoke@example.com', token: 'smoke-token'} },
  async removeAuth(account, hosts, service, expectedToken) { calls.push(['remove', account, hosts, service, expectedToken]) },
  async saveAuth(account, token, hosts, service) { calls.push(['save', account, token, hosts, service]) },
})
await credentials.saveAuth('smoke@example.com', 'smoke-token', ['api.heroku.test'], 'packed-smoke')
const entry = await credentials.getAuth('smoke@example.com', 'api.heroku.test', 'packed-smoke')
await credentials.removeAuth(entry.account, ['api.heroku.test'], 'packed-smoke', entry.token)
if (JSON.stringify(calls.map(call => call[0])) !== JSON.stringify(['save', 'get', 'remove'])) throw new Error('injected credential provider lifecycle failed')

const platformCalls = []
const platform = adapters.createCredentialManagerPlatformAdapter({
  async delete(path, options) { platformCalls.push(['delete', path, options]); return {body: {ok: true}, headers: {}, statusCode: 200} },
  async get(path, options) { platformCalls.push(['get', path, options]); return {body: {ok: true}, headers: {}, statusCode: 200} },
}, 'operation-token')
await platform.get('/account')
await platform.delete('/oauth/authorizations/1')
if (platformCalls.some(call => call[2].headers.Authorization !== 'Bearer operation-token' || call[2].retryAuth !== false)) throw new Error('platform adapter did not bind controlled operation token')

const fetchAdapter = adapters.createCredentialManagerFetchAdapter()
const response = await fetchAdapter(${JSON.stringify(loopbackUrl)}, {headers: {'x-packed-smoke': 'yes'}, redirect: 'error'})
if (response.status !== 200 || await response.text() !== 'loopback-ok') throw new Error('loopback fetch adapter smoke failed')
const config = {dataDir: process.env.HEROKU_DATA_DIR, platform: process.platform, version: 'packed-verifier'}
const api = new root.APIClient(config, {preauth: false, required: false})
api.setAuthEntry({account: undefined, token: undefined})
const loginInstance = new login.Login(config, api)
if (typeof loginInstance.login !== 'function' || typeof loginInstance.logout !== 'function') throw new Error('Login smoke instance is incomplete')
console.log(JSON.stringify({credentialCalls: calls.length, imports: modules.length, loopback: 'ok', platformCalls: platformCalls.length}))
`)

  await writeFile(join(consumerDirectory, 'contract.ts'), `
import Command, {APIClient, type AuthEntry as RootAuthEntry, type IOptions} from '@heroku-cli/command'
import {Login, type Login as LoginTypes} from '@heroku-cli/command/lib/login.js'
import type {AuthEntry as FacadeAuthEntry} from '@heroku-cli/command/lib/credential-manager.js'
import type {AuthEntry as CoreAuthEntry} from '@heroku-cli/command/lib/credential-manager-core/index.js'
import type {AuthEntry as TypesAuthEntry} from '@heroku-cli/command/lib/credential-manager-core/lib/types.js'
type Assert<T extends true> = T
type HistoricalAuthEntry = {account: string | undefined; token: string | undefined}
type IsEqual<L, R> = (<T>() => T extends L ? 1 : 2) extends (<T>() => T extends R ? 1 : 2) ? true : false
type Compatible = [Assert<IsEqual<RootAuthEntry, HistoricalAuthEntry>>, Assert<IsEqual<FacadeAuthEntry, HistoricalAuthEntry>>, Assert<IsEqual<CoreAuthEntry, HistoricalAuthEntry>>, Assert<IsEqual<TypesAuthEntry, HistoricalAuthEntry>>]
const historical: HistoricalAuthEntry = {account: undefined, token: undefined}
const entries: [RootAuthEntry, FacadeAuthEntry, CoreAuthEntry, TypesAuthEntry] = [historical, historical, historical, historical]
const options: IOptions = {preauth: false, required: false}
const client: APIClient = {} as APIClient
const login: Login = new Login({} as ConstructorParameters<typeof Login>[0], client)
const method: LoginTypes.Method = 'browser'
const commandConstructor: typeof Command = Command
client.setAuthEntry(historical)
void client.getAuthEntry()
void login.login({method})
export {type Compatible, commandConstructor, entries, options}
`)
  await writeFile(join(consumerDirectory, 'tsconfig.json'), JSON.stringify({compilerOptions: {module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: false, strict: true, target: 'ES2022', typeRoots: [join(repositoryRoot, 'node_modules/@types')], types: ['node']}, files: ['./contract.ts']}, null, 2))
}

async function listenLoopback() {
  const server = createServer((request, response) => {
    if (request.headers['x-packed-smoke'] !== 'yes') {
      response.writeHead(400).end('missing-header')
      return
    }
    response.writeHead(200, {'content-type': 'text/plain'}).end('loopback-ok')
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  return {server, url: `http://127.0.0.1:${address.port}/smoke`}
}

async function verifyConsumer(tarball, deepPaths) {
  const isolated = await createIsolatedEnvironment('consumer')
  await cp(join(workspace.seedCache, '_cacache'), join(isolated.paths.cache, '_cacache'), {recursive: true})
  workspace.consumerPaths = isolated.paths
  workspace.consumerDirectory = join(workspace.root, 'consumer-project')
  await mkdir(workspace.consumerDirectory)
  await writeFile(join(workspace.consumerDirectory, 'package.json'), JSON.stringify({name: 'packed-command-consumer', private: true, type: 'module'}, null, 2))
  await run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball], {
    cwd: workspace.consumerDirectory,
    env: isolated.environment,
    label: 'fresh consumer npm install --ignore-scripts',
  })
  const commandManifestPath = createRequire(join(workspace.consumerDirectory, 'package.json')).resolve('@heroku-cli/command/package.json')
  const resolvedCommandDirectory = dirname(commandManifestPath)
  check(resolvedCommandDirectory.endsWith(join('@heroku-cli', 'command')), 'installed command package path did not resolve')
  await verifyInstalledGraph(resolvedCommandDirectory)
  const before = await snapshotOutsideWorkspace()
  const loopback = await listenLoopback()
  try {
    await writeConsumerFiles(workspace.consumerDirectory, resolvedCommandDirectory, deepPaths, loopback.url)
    await run(process.execPath, ['smoke.mjs'], {cwd: workspace.consumerDirectory, env: {...isolated.environment, HEROKU_DATA_DIR: isolated.paths.data}, label: 'isolated runtime smoke'})
  } finally {
    await new Promise(resolvePromise => loopback.server.close(resolvePromise))
  }
  await run(process.execPath, [join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.json'], {cwd: workspace.consumerDirectory, env: isolated.environment, label: 'consumer declaration compile'})
  const after = await snapshotOutsideWorkspace()
  assert.deepEqual(after, before, 'runtime smoke wrote to isolated home/config/data outside its dedicated data directory')
}

async function initializeWorkspace() {
  workspace = {redactions: new Set(), root: await mkdtemp(join(tmpdir(), workspacePrefix))}
  workspace.redactions.add(workspace.root)
  workspace.redactions.add(normalizePath(workspace.root))
  if (process.env.HOME) {
    workspace.redactions.add(process.env.HOME)
    workspace.redactions.add(normalizePath(process.env.HOME))
  }
  workspace.npmUserConfig = join(workspace.root, 'npmrc')
  workspace.npmEnvironment = await createMinimalNpmConfig(workspace.npmUserConfig)
  workspace.seedCache = join(workspace.root, 'seed-cache')
  const sourceCache = process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || (process.env.HOME && join(process.env.HOME, '.npm'))
  check(sourceCache, 'an npm cache is required for offline consumer verification')
  workspace.redactions.add(sourceCache)
  workspace.redactions.add(normalizePath(sourceCache))
  await cp(join(sourceCache, '_cacache'), join(workspace.seedCache, '_cacache'), {recursive: true})
  const control = await createIsolatedEnvironment('control')
  workspace.controlPaths = control.paths
  workspace.baseEnvironment = control.environment
  const npmPackagePath = npmCliPath ? resolve(dirname(npmCliPath), '..', 'package.json') : undefined
  const resolvedNpmPackagePath = npmPackagePath ?? join((await run('npm', ['root', '--global'], {env: workspace.baseEnvironment})).stdout.trim(), 'npm', 'package.json')
  const npmRequire = createRequire(resolvedNpmPackagePath)
  pacote = npmRequire('pacote')
  npmTarContents = npmRequire(resolve(dirname(resolvedNpmPackagePath), 'lib/utils/tar.js'))
  npmTar = npmRequire('tar')
  npmPacklist = npmRequire('npm-packlist')
  workspace.Arborist = npmRequire('@npmcli/arborist')
}

async function main() {
  check(Number(process.versions.node.split('.')[0]) >= 20, 'Node 20 or newer is required')
  check(/^[0-9a-f]{40}$/.test(authoritativeBaselineSha), '.github/packed-consumer-baseline must contain exactly one immutable 40-hex commit SHA')
  if (requestedBaselineSha !== undefined) {
    check(requestedBaselineSha === authoritativeBaselineSha, `requested baseline ${requestedBaselineSha} does not equal authoritative baseline ${authoritativeBaselineSha}`) // MUTATION_ANCHOR_BASELINE_EQUALITY
  }
  runSelfChecks()
  await initializeWorkspace()
  await run('git', ['cat-file', '-e', `${authoritativeBaselineSha}^{commit}`], {env: workspace.baseEnvironment, label: `authoritative baseline commit ${authoritativeBaselineSha}`}) // MUTATION_ANCHOR_BASELINE_EXISTENCE
  if (process.env.PACKED_VERIFY_SKIP_MUTATIONS !== '1') await runMutationChecks()
  currentPhase = 'sanitized build and authoritative pack baseline'
  const packDirectory = join(workspace.root, 'pack')
  const baselinePackDirectory = join(workspace.root, 'baseline-pack')
  await Promise.all([mkdir(packDirectory), mkdir(baselinePackDirectory)])
  const packMetadata = await packCurrentSource(packDirectory)
  const baseline = await packOriginBaseline(baselinePackDirectory) // MUTATION_ANCHOR_AUTHORITATIVE_BASELINE
  const tarball = join(packDirectory, packMetadata.filename)

  currentPhase = 'packed manifest extraction and contract'
  workspace.packageRoot = join(workspace.root, 'extracted-package')
  await mkdir(workspace.packageRoot)
  await extractTarball(tarball, workspace.packageRoot)
  workspace.manifest = await readJson(join(workspace.packageRoot, 'package.json'))
  assert.deepEqual(await readFile(join(workspace.packageRoot, 'package.json')), await readFile(join(repositoryRoot, 'package.json')), 'packed package.json bytes differ from the current source manifest')
  for (const [name, artifact] of expectedDependencies) assert.equal(workspace.manifest.dependencies?.[name], artifact.version, `${name} must be exact ${artifact.version}`)
  const manifestSummary = await verifyPackManifest(packMetadata, baseline)

  currentPhase = 'TypeScript AST reachable graph'
  const packedFiles = await walk(workspace.packageRoot)
  const packedSourceFiles = packedFiles.filter(path => /\.(?:js|cjs|mjs|d\.ts)$/.test(path))
  for (const path of packedSourceFiles) {
    const source = await readFile(join(workspace.packageRoot, path), 'utf8')
    check(!/\bLoginHttp\w*/.test(source), `found removed LoginHttp* symbol in packed file ${path}`) // MUTATION_ANCHOR_PACKED_LOGIN_HTTP
  }
  const packedFileSet = new Set(packedFiles)
  const graph = await inspectReachableGraph(['lib/index.js', 'lib/login.js', 'lib/credential-manager.js', 'lib/index.d.ts', 'lib/login.d.ts', 'lib/credential-manager.d.ts'], packedFileSet)
  check(graph.externalSpecifiers.has('@heroku/heroku-credential-manager'), 'reachable AST graph does not import credential-manager root')
  check(graph.externalSpecifiers.has('@heroku/heroku-credential-manager/login'), 'reachable AST graph does not import credential-manager/login')
  check(graph.externalSpecifiers.has('@heroku/http-call/lib/proxy.js'), 'reachable AST graph/package resolution missing @heroku/http-call/lib/proxy.js') // MUTATION_ANCHOR_PROXY_GRAPH
  const packedText = (await Promise.all(packedSourceFiles.map(path => readFile(join(workspace.packageRoot, path), 'utf8')))).join('\n')
  check(!/(?:_authToken|npm_config_userconfig|\buserconfig\b|registry\.npmjs\.org:[^@\s]+@)/i.test(packedText), 'packed artifact contains registry authentication or userconfig data')
  for (const secret of workspace.redactions) if (secret.length >= 4) check(!packedText.includes(secret), 'packed artifact contains a sensitive environment/config value')

  currentPhase = 'fresh ESM consumer'
  const deepPaths = [...expectedCompatibilityPaths].filter(path => path.startsWith('lib/credential-manager-core/'))
  await verifyConsumer(tarball, deepPaths)
  console.log('Packed command consumer verification passed.')
  console.log(`Runtime: Node ${process.versions.node}`)
  console.log(`Package: ${workspace.manifest.name}@${workspace.manifest.version}`)
  console.log(`Tarball manifest: ${manifestSummary.paths.length} files; ${packMetadata.unpackedSize} unpacked bytes`)
  console.log(`Authoritative baseline: ${authoritativeBaselineSha} (${baseline.manifest.version}); intentional additions observed: ${manifestSummary.added.length}`)
  console.log(`Compatibility imports: ${deepPaths.length} historical JS paths plus root/login/credential-manager`)
  console.log(`Dependencies: ${[...expectedDependencies].map(([name, artifact]) => `${name}@${artifact.version}`).join(', ')} (resolved manifests and integrity verified)`)
  console.log('Lifecycle scope: current build and immutable baseline build were sanitized; both packs and both dependency installs used --ignore-scripts')
  console.log('Security: AST graph resolved, proxy deep import loaded, credential/loopback smoke isolated, no deprecated or sensitive packed artifacts')
  if (workspace.mutationEvidence) {
    console.log(`Mutation baseline: ${workspace.mutationEvidence.baseline}`)
    console.log(`Mutation proxy: ${workspace.mutationEvidence.proxy}`)
  }
}

try {
  await main()
} catch (error) {
  console.error(`Packed command consumer verification failed: ${redact(error.message)}`)
  process.exitCode = 1
} finally {
  if (workspace?.root) {
    try {
      await rm(workspace.root, {force: true, recursive: true})
    } catch (error) {
      console.error(`Warning: temporary verifier cleanup failed: ${redact(error.message)}`)
      process.exitCode = 1
    }
  }
}
