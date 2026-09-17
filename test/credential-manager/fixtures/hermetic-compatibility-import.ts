import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const temporaryHome = process.env.HEROKU_TEST_TEMP_HOME
const realHome = process.env.HEROKU_TEST_REAL_HOME

assert(temporaryHome, 'HEROKU_TEST_TEMP_HOME must be set before importing compatibility modules')
assert(realHome, 'HEROKU_TEST_REAL_HOME must be set before importing compatibility modules')
assert.equal(os.homedir(), temporaryHome)

const realHomeAccesses: string[] = []
const sourceRoot = process.env.HEROKU_TEST_SOURCE_ROOT
assert(sourceRoot, 'HEROKU_TEST_SOURCE_ROOT must be set before importing compatibility modules')
assert.equal(fs.existsSync(path.join(sourceRoot, 'lib')), false, 'compatibility import must not depend on a built lib directory')
const isWithin = (candidate: fs.PathLike, root: string): boolean => {
  const resolved = path.resolve(String(candidate))
  const relative = path.relative(path.resolve(root), resolved)
  return relative === '' || (
    !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative)
  )
}

const recordRealHomeAccess = (operation: string, candidate: fs.PathLike): void => {
  if (isWithin(candidate, realHome) && !isWithin(candidate, sourceRoot)) {
    realHomeAccesses.push(`${operation}:${String(candidate)}`)
  }
}

const {
  existsSync,
  readFile,
  readFileSync,
} = fs
const {readFile: promisesReadFile} = fs.promises

fs.existsSync = ((candidate: fs.PathLike) => {
  recordRealHomeAccess('existsSync', candidate)
  return existsSync(candidate)
}) as typeof fs.existsSync
fs.readFile = ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
  if (typeof candidate !== 'number') recordRealHomeAccess('readFile', candidate)
  return Reflect.apply(readFile, fs, [candidate, ...args])
}) as typeof fs.readFile
fs.readFileSync = ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
  if (typeof candidate !== 'number') recordRealHomeAccess('readFileSync', candidate)
  return Reflect.apply(readFileSync, fs, [candidate, ...args])
}) as typeof fs.readFileSync
fs.promises.readFile = ((candidate: fs.PathLike | fs.promises.FileHandle, ...args: unknown[]) => {
  if (typeof candidate !== 'object' || !('fd' in candidate)) recordRealHomeAccess('promises.readFile', candidate as fs.PathLike)
  return Reflect.apply(promisesReadFile, fs.promises, [candidate, ...args])
}) as typeof fs.promises.readFile

// eslint-disable-next-line n/no-extraneous-import
const externalCredentialManager = await import('@heroku/heroku-credential-manager')
const commandRoot = await import('../../../src/index.js')
const legacyCredentialManager = await import('../../../src/credential-manager-core/index.js')
const netrcParser = await import('../../../src/credential-manager-core/lib/netrc-parser.js')

const historicalRuntimeExports = [
  'CredentialStore',
  'LinuxHandler',
  'MacOSHandler',
  'Netrc',
  'NetrcHandler',
  'WindowsHandler',
  'deleteLoginState',
  'getAuth',
  'getCredentialHandler',
  'getNativeCredentialStore',
  'getStorageConfig',
  'listKeychainAccounts',
  'parse',
  'readLoginState',
  'removeAuth',
  'saveAuth',
  'writeLoginState',
] as const

for (const name of historicalRuntimeExports) {
  assert.equal(legacyCredentialManager[name], externalCredentialManager[name], `credential-manager-core ${name}`)
  assert.equal(commandRoot[name], externalCredentialManager[name], `command root ${name}`)
}

assert(netrcParser.default instanceof externalCredentialManager.Netrc)
assert.equal(path.dirname(netrcParser.default.file), temporaryHome)
assert.deepEqual(realHomeAccesses, [])

process.stdout.write(JSON.stringify({
  defaultNetrcPath: netrcParser.default.file,
  realHomeAccesses,
}))
