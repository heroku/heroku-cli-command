import * as fs from 'fs'
import * as path from 'path'

function flatten(arr: any[]): any[] {
  return arr.reduce((a, b) => a.concat(Array.isArray(b) ? flatten(b) : b), [])
}

export function getCommands(dir: string): any {
  function requireCommand(f: string): any {
    let c = require(f)
    return c.default ? c.default : c
  }

  let all = fs.readdirSync(dir).map(f => path.join(dir, f))
  let commands = all.filter(f => path.extname(f) === '.js' && !f.endsWith('.test.js')).map(requireCommand)
  let subs = all.filter(f => fs.lstatSync(f).isDirectory()).map(getCommands)

  return flatten(commands.concat(flatten(subs)))
}
