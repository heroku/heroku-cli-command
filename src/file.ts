import debugModule from 'debug'
import * as fs from 'node:fs'
import {promisify} from 'node:util'

let _debug: any
function debug(...args: any[]) {
  if (!_debug) _debug = debugModule('@heroku-cli/command:file')
  _debug(...args)
}

export function exists(f: string): Promise<boolean> {
  return promisify(fs.exists)(f)
}

export function readdir(f: string): Promise<string[]> {
  debug('readdir', f)
  return promisify(fs.readdir)(f)
}

export function readFile(f: string) {
  debug('readFile', f)
  return promisify(fs.readFile)(f)
}
