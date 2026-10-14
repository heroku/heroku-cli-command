import {expect} from 'chai'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {
  cleanupPublicNpmConfig,
  createPublicNpmEnvironment,
  preparePublicNpmConfig,
  publicNpmConfig,
  writePublicNpmConfig,
} from '../scripts/public-npm-config.mjs'

describe('public npm config', () => {
  it('writes a public-only npm config and applies owner-only permissions', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'public-npm-config-'))
    const configPath = path.join(directory, '.npmrc')

    try {
      await writePublicNpmConfig(configPath)
      expect(readFileSync(configPath, 'utf8')).to.equal(publicNpmConfig)
      expect(readFileSync(configPath, 'utf8')).to.match(/^registry=https:\/\/registry\.npmjs\.org\/\n$/)
      expect(readFileSync(configPath, 'utf8')).not.to.match(/_authToken|_auth|NODE_AUTH_TOKEN|NPM_READ_TOKEN|always-auth/)
      expect(statSync(configPath).mode % 0o1000).to.equal(0o600)
    } finally {
      rmSync(directory, {force: true, recursive: true})
    }
  })

  it('strips ambient npm auth/config and uses isolated public registry paths', () => {
    const environment = createPublicNpmEnvironment({
      HOME: '/private/home',
      NODE_AUTH_TOKEN: 'secret-node-token',
      'npm_config_//registry.npmjs.org/:_authToken': 'secret-npm-token',
      npm_config_registry: 'https://private.example/',
      NPM_CONFIG_USERCONFIG: '/private/.npmrc',
      NPM_TOKEN: 'secret-npm-token',
    }, {
      cachePath: '/tmp/isolated/cache',
      configPath: '/tmp/isolated/npmrc',
      globalConfigPath: '/tmp/isolated/global.npmrc',
      logsPath: '/tmp/isolated/logs',
    })

    expect(environment.HOME).to.equal('/private/home')
    expect(environment.NODE_AUTH_TOKEN).to.equal('')
    expect(environment.NPM_TOKEN).to.equal('')
    expect(environment.npm_config_registry).to.equal('https://registry.npmjs.org/')
    expect(environment.NPM_CONFIG_REGISTRY).to.equal('https://registry.npmjs.org/')
    expect(environment.NPM_CONFIG_USERCONFIG).to.equal('/tmp/isolated/npmrc')
    expect(environment.NPM_CONFIG_GLOBALCONFIG).to.equal('/tmp/isolated/global.npmrc')
    expect(environment.NPM_CONFIG_CACHE).to.equal('/tmp/isolated/cache')
    expect(environment.NPM_CONFIG_LOGS_DIR).to.equal('/tmp/isolated/logs')
    expect(Object.entries(environment).some(([key, value]) => /authToken/i.test(key) || /secret-(?:node|npm)-token/.test(String(value)))).to.equal(false)
  })

  it('prepares anonymous public npm settings for subsequent CI steps', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'public-npm-prepare-'))
    const project = path.join(root, 'project')
    const runnerTemp = path.join(root, 'runner-temp')
    const githubEnv = path.join(root, 'github-env')
    mkdirSync(project)
    mkdirSync(runnerTemp)
    writeFileSync(githubEnv, '')

    try {
      const result = await preparePublicNpmConfig(runnerTemp, githubEnv, {
        NODE_AUTH_TOKEN: 'secret-node-token',
        npm_config_registry: 'https://private.example/',
        NPM_CONFIG_USERCONFIG: '/ambient/.npmrc',
        PRIVATE_NPM_TOKEN: 'not npm auth setting',
      }, project)
      const config = readFileSync(result.configPath, 'utf8')
      const exports = readFileSync(githubEnv, 'utf8')

      expect(config).to.equal(publicNpmConfig)
      expect(exports).to.include(`NPM_CONFIG_USERCONFIG=${result.configPath}`)
      expect(exports).to.include(`NPM_CONFIG_GLOBALCONFIG=${result.globalConfigPath}`)
      expect(exports).to.include(`NPM_CONFIG_CACHE=${result.cachePath}`)
      expect(exports).to.include(`NPM_CONFIG_LOGS_DIR=${result.logsPath}`)
      expect(exports).to.include('NPM_CONFIG_REGISTRY=https://registry.npmjs.org/')
      expect(exports).to.include('NODE_AUTH_TOKEN=')
      expect(exports).to.include('NPM_TOKEN=')
      expect(exports).not.to.include('secret-node-token')
      expect(exports).not.to.include('https://private.example/')
      expect(readFileSync(result.globalConfigPath, 'utf8')).to.equal(publicNpmConfig)
      expect(readdirSync(runnerTemp)).to.have.length(1)
    } finally {
      rmSync(root, {force: true, recursive: true})
    }
  })

  it('removes only isolated npm config, cache, and log state', async () => {
    const runnerTemp = mkdtempSync(path.join(tmpdir(), 'public-npm-cleanup-'))
    const managed = path.join(runnerTemp, 'heroku-command-public-npm-test')
    const unrelated = path.join(runnerTemp, 'other-temporary-state')
    mkdirSync(path.join(managed, 'cache'), {recursive: true})
    mkdirSync(path.join(managed, 'logs'))
    writeFileSync(path.join(managed, 'npmrc'), publicNpmConfig)
    writeFileSync(path.join(managed, 'cache', 'index'), 'cache')
    writeFileSync(path.join(managed, 'logs', 'debug.log'), 'log')
    mkdirSync(unrelated)
    writeFileSync(path.join(unrelated, 'preserve'), 'unrelated')

    try {
      expect(await cleanupPublicNpmConfig(runnerTemp)).to.equal(1)
      expect(readdirSync(runnerTemp)).to.deep.equal(['other-temporary-state'])
      expect(readFileSync(path.join(unrelated, 'preserve'), 'utf8')).to.equal('unrelated')
    } finally {
      rmSync(runnerTemp, {force: true, recursive: true})
    }
  })

  it('rejects project .npmrc so installs cannot inherit package-local auth', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'public-npm-project-config-'))
    const project = path.join(root, 'project')
    const runnerTemp = path.join(root, 'runner-temp')
    mkdirSync(project)
    mkdirSync(runnerTemp)
    writeFileSync(path.join(project, '.npmrc'), '//registry.npmjs.org/:_authToken=project-secret\n')
    writeFileSync(path.join(root, 'github-env'), '')

    try {
      await assert.rejects(
        preparePublicNpmConfig(runnerTemp, path.join(root, 'github-env'), {}, project),
        /Project \.npmrc is forbidden/,
      )
    } finally {
      rmSync(root, {force: true, recursive: true})
    }
  })
})
