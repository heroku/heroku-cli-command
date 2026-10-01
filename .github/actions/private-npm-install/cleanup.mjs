import {appendFileSync, existsSync, realpathSync, rmSync} from 'node:fs'
import {relative, resolve} from 'node:path'

const runnerTemp = process.env.PRIVATE_NPM_BASE || process.env.RUNNER_TEMP
const root = process.env.PRIVATE_NPM_ROOT
const userconfig = process.env.PRIVATE_NPM_USERCONFIG
const cleanRoot = process.env.PRIVATE_NPM_CLEAN_ROOT
const cleanUserconfig = process.env.PRIVATE_NPM_CLEAN_USERCONFIG

if (!runnerTemp || !root || !userconfig || !cleanRoot || !cleanUserconfig) {
  throw new Error('RUNNER_TEMP and private npm paths are required for cleanup')
}

const resolvedTemp = existsSync(runnerTemp) ? realpathSync(runnerTemp) : resolve(runnerTemp)
const resolvedRoot = existsSync(root) ? realpathSync(root) : resolve(root)
const relativeRoot = relative(resolvedTemp, resolvedRoot)

if (!relativeRoot || relativeRoot.startsWith('..') || resolve(resolvedTemp, relativeRoot) !== resolvedRoot) {
  throw new Error('Refusing to remove a path outside RUNNER_TEMP')
}

if (!relativeRoot.startsWith('private-npm-')) {
  throw new Error('Refusing to remove an unexpected temporary directory')
}

const resolvedCleanRoot = existsSync(cleanRoot) ? realpathSync(cleanRoot) : resolve(cleanRoot)
const relativeCleanRoot = relative(resolvedTemp, resolvedCleanRoot)
if (
  !relativeCleanRoot ||
  relativeCleanRoot.startsWith('..') ||
  resolve(resolvedTemp, relativeCleanRoot) !== resolvedCleanRoot ||
  !relativeCleanRoot.startsWith('private-npm-') ||
  !relativeCleanRoot.endsWith('-clean')
) {
  throw new Error('Refusing to retain an unexpected clean npm directory')
}

rmSync(userconfig, {force: true})
rmSync(resolvedRoot, {force: true, recursive: true})

appendFileSync(process.env.GITHUB_ENV, 'NODE_AUTH_TOKEN=\n')
appendFileSync(process.env.GITHUB_ENV, `NPM_CONFIG_USERCONFIG=${cleanUserconfig}\n`)
appendFileSync(process.env.GITHUB_ENV, `NPM_CONFIG_CACHE=${process.env.PRIVATE_NPM_CLEAN_CACHE}\n`)
appendFileSync(process.env.GITHUB_ENV, `NPM_CONFIG_LOGS_DIR=${process.env.PRIVATE_NPM_CLEAN_LOGS}\n`)
