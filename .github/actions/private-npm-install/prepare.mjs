import {appendFileSync, chmodSync, mkdirSync, writeFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {join, resolve} from 'node:path'

const output = process.env.GITHUB_OUTPUT
const runnerTemp = process.env.PRIVATE_NPM_BASE || process.env.RUNNER_TEMP

if (!output || !runnerTemp) {
  throw new Error('GITHUB_OUTPUT and RUNNER_TEMP are required')
}

const safe = value => (value || 'local').replaceAll(/[^A-Za-z0-9_.-]/g, '_')
const root = resolve(
  runnerTemp,
  `private-npm-${safe(process.env.RUN_ID)}-${safe(process.env.RUN_ATTEMPT)}-${safe(process.env.JOB_NAME)}-${randomUUID()}`,
)
const cache = join(root, 'cache')
const logs = join(root, 'logs')
const userconfig = join(root, '.npmrc')
const cleanRoot = join(runnerTemp, `${root.split(/[\\/]/).at(-1)}-clean`)
const cleanCache = join(cleanRoot, 'cache')
const cleanLogs = join(cleanRoot, 'logs')
const cleanUserconfig = join(cleanRoot, '.npmrc')

mkdirSync(cache, {mode: 0o700, recursive: true})
mkdirSync(logs, {mode: 0o700, recursive: true})
mkdirSync(cleanCache, {mode: 0o700, recursive: true})
mkdirSync(cleanLogs, {mode: 0o700, recursive: true})
writeFileSync(userconfig, '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\nregistry=https://registry.npmjs.org/\n', {
  mode: 0o600,
})
writeFileSync(cleanUserconfig, 'registry=https://registry.npmjs.org/\n', {mode: 0o600})

if (process.platform !== 'win32') {
  for (const directory of [root, cache, logs, cleanRoot, cleanCache, cleanLogs]) chmodSync(directory, 0o700)
  for (const config of [userconfig, cleanUserconfig]) chmodSync(config, 0o600)
}

for (const [name, value] of Object.entries({
  root,
  cache,
  logs,
  userconfig,
  clean_root: cleanRoot,
  clean_cache: cleanCache,
  clean_logs: cleanLogs,
  clean_userconfig: cleanUserconfig,
})) {
  appendFileSync(output, `${name}=${value}\n`)
}

appendFileSync(process.env.GITHUB_ENV, `NPM_CONFIG_USERCONFIG=${userconfig}\n`)
