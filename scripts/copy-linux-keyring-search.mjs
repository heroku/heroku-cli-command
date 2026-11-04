import {copyFile, mkdir} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'src/credential-manager-core/credential-handlers/linux-keyring-search.mjs')
const target = resolve(root, 'lib/credential-manager-core/credential-handlers/linux-keyring-search.mjs')

await mkdir(dirname(target), {recursive: true})
await copyFile(source, target)
