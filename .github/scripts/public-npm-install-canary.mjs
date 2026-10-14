import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {
  mkdir, mkdtemp, readdir, readFile, rm, writeFile,
} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'

import {createPublicNpmEnvironment, preparePublicNpmConfig, publicNpmConfig} from '../../scripts/public-npm-config.mjs'

const execFileAsync = promisify(execFile)
const npmPackage = '@heroku/heroku-credential-manager'
const npmVersion = '0.1.0'
const fakeToken = `public-install-canary-secret-${process.pid}`

async function npm(args, cwd, env) {
  try {
    return await execFileAsync('npm', args, {
      cwd, encoding: 'utf8', env, maxBuffer: 10 * 1024 * 1024,
    })
  } catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`
    assert.equal(output.includes(fakeToken), false, 'fake ambient npm token appeared in npm output')
    throw new Error(`npm ${args.join(' ')} failed (${error.code ?? error.signal}): ${output.replaceAll(fakeToken, '[redacted]')}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'public-npm-install-canary-'))
try {
  const project = join(root, 'consumer')
  const runnerTemp = join(root, 'runner-temp')
  const githubEnv = join(root, 'github-env')
  await mkdir(project)
  await mkdir(runnerTemp)
  await writeFile(githubEnv, '')
  await writeFile(join(project, 'package.json'), JSON.stringify({
    dependencies: {[npmPackage]: npmVersion},
    name: 'anonymous-public-install-canary',
    private: true,
    version: '1.0.0',
  }, null, 2))

  const setup = await preparePublicNpmConfig(runnerTemp, githubEnv, {
    ...process.env,
    NODE_AUTH_TOKEN: fakeToken,
    'npm_config_//registry.npmjs.org/:_authToken': fakeToken,
    NPM_CONFIG_REGISTRY: 'https://registry.invalid/',
    NPM_CONFIG_USERCONFIG: join(root, 'nonexistent-credential.npmrc'),
    NPM_TOKEN: fakeToken,
    npmConfigRegistry: 'https://registry.invalid/',
    npmConfigUserconfig: join(root, 'nonexistent-credential.npmrc'),
  }, project)
  const environment = createPublicNpmEnvironment({
    ...process.env,
    HOME: join(root, 'home'),
    NODE_AUTH_TOKEN: fakeToken,
    'npm_config_//registry.npmjs.org/:_authToken': fakeToken,
    NPM_CONFIG_REGISTRY: 'https://registry.invalid/',
    NPM_CONFIG_USERCONFIG: join(root, 'nonexistent-credential.npmrc'),
    NPM_TOKEN: fakeToken,
    npmConfigRegistry: 'https://registry.invalid/',
    npmConfigUserconfig: join(root, 'nonexistent-credential.npmrc'),
    USERPROFILE: join(root, 'home'),
  }, setup)
  assert.equal(environment.NPM_CONFIG_USERCONFIG, setup.configPath)
  assert.equal(await readFile(environment.NPM_CONFIG_USERCONFIG, 'utf8'), publicNpmConfig)
  assert.equal(environment.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org/')
  assert.equal(environment.npm_config_registry, 'https://registry.npmjs.org/')
  assert.equal(environment.NODE_AUTH_TOKEN, '')
  assert.equal(environment.NPM_TOKEN, '')
  for (const [key, value] of Object.entries(environment)) {
    assert.doesNotMatch(key, /^npm_config_.*(?:_auth|token|password|username)/i, `environment contains npm auth setting ${key}`)
    assert.doesNotMatch(key, /_authToken/i, `environment contains registry auth setting ${key}`)
    assert.equal(String(value).includes(fakeToken), false, `environment contains fake credential value in ${key}`)
  }

  // Resolve an initial lockfile, then prove a clean install succeeds with empty cache and no auth.
  await npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], project, environment)
  await rm(setup.cachePath, {force: true, recursive: true})
  await mkdir(setup.cachePath)
  await npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], project, environment)

  const manifest = JSON.parse(await readFile(join(project, 'node_modules', npmPackage, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(project, 'package-lock.json'), 'utf8'))
  const locked = lock.packages?.[`node_modules/${npmPackage}`]
  assert.equal(manifest.version, npmVersion)
  assert.equal(locked?.version, npmVersion)
  assert.equal(locked?.resolved, `https://registry.npmjs.org/@heroku/heroku-credential-manager/-/heroku-credential-manager-${npmVersion}.tgz`)
  const logFiles = await readdir(setup.logsPath)
  const logContents = await Promise.all(logFiles.map(logFile => readFile(join(setup.logsPath, logFile), 'utf8')))
  assert.equal(logContents.some(contents => contents.includes(fakeToken)), false, 'fake ambient npm token appeared in npm logs')

  assert.equal((await readFile(githubEnv, 'utf8')).includes(fakeToken), false, 'fake ambient npm token appeared in runner environment exports')
  console.log('public npm install canary passed (empty-cache npm ci installed the pinned dependency anonymously from registry.npmjs.org)')
} finally {
  await rm(root, {force: true, recursive: true})
}
