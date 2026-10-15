import {existsSync} from 'node:fs'
import {
  chmod, mkdir, mkdtemp, readdir, rm, writeFile,
} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

export const publicNpmConfig = 'registry=https://registry.npmjs.org/\n'
export const publicNpmConfigDirectoryPrefix = 'heroku-command-public-npm-'

export async function writePublicNpmConfig(target) {
  await mkdir(dirname(target), {mode: 0o700, recursive: true})
  await writeFile(target, publicNpmConfig, {mode: 0o600})
  await chmod(target, 0o600)
}

export function createPublicNpmEnvironment(environment, {cachePath, configPath, globalConfigPath, logsPath}) {
  const isolated = {...environment}
  for (const name of Object.keys(isolated)) {
    if (/^npm_config_/i.test(name) || /^(?:node_auth_token|npm_token)$/i.test(name) || /^npm_config_.*(?:auth|token|password|username)/i.test(name)) delete isolated[name]
  }

  const result = {
    ...isolated,
    NODE_AUTH_TOKEN: '',
    NPM_CONFIG_CACHE: cachePath,
    NPM_CONFIG_GLOBALCONFIG: globalConfigPath ?? configPath,
    NPM_CONFIG_LOGS_DIR: logsPath,
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    NPM_CONFIG_USERCONFIG: configPath,
    NPM_TOKEN: '',
  }
  for (const [key, value] of [
    ['npm_config_cache', cachePath],
    ['npm_config_globalconfig', globalConfigPath ?? configPath],
    ['npm_config_logs_dir', logsPath],
    ['npm_config_registry', 'https://registry.npmjs.org/'],
    ['npm_config_userconfig', configPath],
  ]) Reflect.set(result, key, value)
  return result
}

export async function preparePublicNpmConfig(runnerTemp, githubEnv, environment = process.env, projectDirectory = process.cwd()) {
  if (!runnerTemp || !githubEnv) throw new Error('RUNNER_TEMP and GITHUB_ENV are required')
  const forbiddenConfigs = ['.npmrc', 'npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs']
  const presentConfig = forbiddenConfigs.find(name => existsSync(join(projectDirectory, name)))
  if (presentConfig) throw new Error(`Project ${presentConfig} is forbidden for anonymous npm operations`)

  const directory = await mkdtemp(join(runnerTemp, publicNpmConfigDirectoryPrefix))
  await chmod(directory, 0o700)
  const configPath = join(directory, 'npmrc')
  const globalConfigPath = join(directory, 'global.npmrc')
  const cachePath = join(directory, 'cache')
  const logsPath = join(directory, 'logs')
  await mkdir(cachePath, {mode: 0o700})
  await mkdir(logsPath, {mode: 0o700})
  await writePublicNpmConfig(configPath)
  await writePublicNpmConfig(globalConfigPath)

  const exportedEnvironment = new Map([
    ['NODE_AUTH_TOKEN', ''],
    ['NPM_TOKEN', ''],
  ])
  for (const name of Object.keys(environment)) {
    const normalizedName = name.toLowerCase()
    if (normalizedName.startsWith('npm_config_')) {
      exportedEnvironment.set(name, '')
      exportedEnvironment.set(normalizedName, '')
      exportedEnvironment.set(normalizedName.toUpperCase(), '')
    }

    if (/^(?:node_auth_token|npm_token)$/.test(normalizedName)) {
      exportedEnvironment.set(name, '')
      exportedEnvironment.set(normalizedName, '')
      exportedEnvironment.set(normalizedName.toUpperCase(), '')
    }
  }

  const forcedSettings = createPublicNpmEnvironment({}, {
    cachePath, configPath, globalConfigPath, logsPath,
  })
  for (const [name, value] of Object.entries(forcedSettings)) {
    exportedEnvironment.set(name, value)
  }

  await writeFile(githubEnv, `${[...exportedEnvironment].map(([name, value]) => `${name}=${value}`).join('\n')}\n`, {flag: 'a'})
  return {
    cachePath, configPath, directory, globalConfigPath, logsPath,
  }
}

export async function cleanupPublicNpmConfig(runnerTemp) {
  if (!runnerTemp) throw new Error('RUNNER_TEMP is required')

  const entries = await readdir(runnerTemp, {withFileTypes: true})
  const directories = entries.filter(entry => entry.isDirectory() && entry.name.startsWith(publicNpmConfigDirectoryPrefix))
  await Promise.all(directories.map(entry => rm(join(runnerTemp, entry.name), {force: true, recursive: true})))
  return directories.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'cleanup') {
    const removed = await cleanupPublicNpmConfig(process.env.RUNNER_TEMP)
    console.log(`Removed ${removed} isolated public npm configuration director${removed === 1 ? 'y' : 'ies'}`)
  } else {
    if (process.argv[2] && process.argv[2] !== 'setup') throw new Error(`Unknown public npm config command: ${process.argv[2]}`)
    const result = await preparePublicNpmConfig(process.env.RUNNER_TEMP, process.env.GITHUB_ENV)
    console.log(`Prepared anonymous public npm configuration: ${result.configPath}`)
  }
}
