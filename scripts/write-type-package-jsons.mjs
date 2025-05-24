// This script writes a package.json with the correct "type" field to both lib/esm and lib/cjs
import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import pjson from '../package.json' with {type: 'json'}

const targets = [
  {dir: join(import.meta.dirname, '../lib/esm'), type: 'module'},
  {dir: join(import.meta.dirname, '../lib/cjs'), type: 'commonjs'},
]

targets.forEach(({dir, type}) => {
  if (!existsSync(dir)) {
    mkdirSync(dir, {recursive: true})
  }

  const pkgPath = join(dir, 'package.json')
  const pkgContent = JSON.stringify({name: pjson.name, type, version: pjson.version}, null, 2) + '\n'
  writeFileSync(pkgPath, pkgContent)
  process.stdout.write(`Wrote ${pkgPath}\n`)
})
