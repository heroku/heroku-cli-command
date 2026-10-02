import {appendFileSync, cpSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync} from 'node:fs'
import {join, relative, resolve} from 'node:path'

const runnerTemp = process.env.PRIVATE_NPM_BASE || process.env.RUNNER_TEMP
const cache = process.env.PRIVATE_NPM_CACHE
const root = process.env.PRIVATE_NPM_ROOT
const userconfig = process.env.PRIVATE_NPM_USERCONFIG
const cleanRoot = process.env.PRIVATE_NPM_CLEAN_ROOT
const cleanCache = process.env.PRIVATE_NPM_CLEAN_CACHE
const cleanUserconfig = process.env.PRIVATE_NPM_CLEAN_USERCONFIG
const retainCache = process.env.PRIVATE_NPM_RETAIN_CACHE
const readToken = process.env.READ_TOKEN

if (!runnerTemp || !cache || !root || !userconfig || !cleanRoot || !cleanCache || !cleanUserconfig) {
  throw new Error('RUNNER_TEMP and private npm paths are required for cleanup')
}
if (retainCache !== 'true' && retainCache !== 'false') throw new Error('PRIVATE_NPM_RETAIN_CACHE must be true or false')

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

let retentionError
try {
  if (retainCache === 'true') {
    if (!readToken) throw new Error('READ_TOKEN is required when retaining the npm cache')
    const resolvedCache = existsSync(cache) ? realpathSync(cache) : resolve(cache)
    const resolvedCleanCache = existsSync(cleanCache) ? realpathSync(cleanCache) : resolve(cleanCache)
    const relativeCache = relative(resolvedRoot, resolvedCache)
    const relativeCleanCache = relative(resolvedCleanRoot, resolvedCleanCache)
    if (
      !relativeCache ||
      relativeCache.startsWith('..') ||
      resolve(resolvedRoot, relativeCache) !== resolvedCache ||
      !relativeCleanCache ||
      relativeCleanCache.startsWith('..') ||
      resolve(resolvedCleanRoot, relativeCleanCache) !== resolvedCleanCache
    ) {
      throw new Error('Refusing to transfer an npm cache outside its expected root')
    }

    const contentCache = join(resolvedCache, '_cacache')
    if (!existsSync(contentCache)) throw new Error('The authenticated npm install did not populate its content cache')
    const pending = [contentCache]
    while (pending.length > 0) {
      const path = pending.pop()
      for (const entry of readdirSync(path, {withFileTypes: true})) {
        const entryPath = join(path, entry.name)
        if (entry.isDirectory()) pending.push(entryPath)
        else if (entry.isFile() && readFileSync(entryPath).includes(readToken)) {
          throw new Error('Refusing to retain an npm cache containing the read token')
        }
      }
    }

    cpSync(contentCache, join(resolvedCleanCache, '_cacache'), {recursive: true})
  }
} catch (error) {
  retentionError = error
} finally {
  rmSync(userconfig, {force: true})
  rmSync(resolvedRoot, {force: true, recursive: true})

  appendFileSync(process.env.GITHUB_ENV, 'NODE_AUTH_TOKEN=\n')
  appendFileSync(process.env.GITHUB_ENV, `NPM_CONFIG_USERCONFIG=${cleanUserconfig}\n`)
  appendFileSync(process.env.GITHUB_ENV, `NPM_CONFIG_CACHE=${cleanCache}\n`)
  appendFileSync(process.env.GITHUB_ENV, `NPM_CONFIG_LOGS_DIR=${process.env.PRIVATE_NPM_CLEAN_LOGS}\n`)
}

if (retentionError) throw retentionError
