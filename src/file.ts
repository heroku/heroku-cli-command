import debugModule from 'debug'
import * as fs from 'node:fs'
import {promisify} from 'node:util'

let _debug: any
function debug(...args: any[]) {
  if (!_debug) _debug = debugModule('@heroku-cli/command:file')
  _debug(...args)
}

export async function exists(f: string): Promise<boolean> {
  // eslint-disable-next-line n/no-deprecated-api
  return promisify(fs.exists)(f)
}

export async function readdir(f: string): Promise<string[]> {
  debug('readdir', f)
  return promisify(fs.readdir)(f)
}

export async function readFile(f: string) {
  debug('readFile', f)
  return promisify(fs.readFile)(f)
}
