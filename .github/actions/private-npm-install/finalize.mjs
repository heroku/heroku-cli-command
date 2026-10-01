import {appendFileSync, existsSync, realpathSync, rmSync} from 'node:fs'
import {relative, resolve} from 'node:path'

const runnerTemp = process.env.PRIVATE_NPM_BASE || process.env.RUNNER_TEMP
const cleanRoot = process.env.PRIVATE_NPM_CLEAN_ROOT

if (!runnerTemp || !cleanRoot) throw new Error('RUNNER_TEMP and PRIVATE_NPM_CLEAN_ROOT are required')

const resolvedTemp = existsSync(runnerTemp) ? realpathSync(runnerTemp) : resolve(runnerTemp)
const resolvedRoot = existsSync(cleanRoot) ? realpathSync(cleanRoot) : resolve(cleanRoot)
const relativeRoot = relative(resolvedTemp, resolvedRoot)

if (
  !relativeRoot ||
  relativeRoot.startsWith('..') ||
  resolve(resolvedTemp, relativeRoot) !== resolvedRoot ||
  !relativeRoot.startsWith('private-npm-') ||
  !relativeRoot.endsWith('-clean')
) {
  throw new Error('Refusing to remove an unexpected clean npm directory')
}

rmSync(resolvedRoot, {force: true, recursive: true})
for (const name of ['NODE_AUTH_TOKEN', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_LOGS_DIR']) {
  appendFileSync(process.env.GITHUB_ENV, `${name}=\n`)
}
