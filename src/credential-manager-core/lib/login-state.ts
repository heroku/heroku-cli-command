import debug from 'debug'
import * as fs from 'node:fs'
import {join} from 'node:path'

const credDebug = debug('heroku-credential-manager')

const LOGIN_STATE_FILE = 'login.json'

type LoginState = {
  account: string
}

export function readLoginState(dataDir: string): LoginState | undefined {
  const filePath = join(dataDir, LOGIN_STATE_FILE)

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(content)

    if (typeof parsed?.account === 'string' && parsed.account.length > 0) {
      return {account: parsed.account}
    }

    credDebug('login state file missing valid account field: %s', filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      credDebug('failed to read login state file: %s', (error as Error).message)
    }
  }
}

export async function writeLoginState(dataDir: string, account: string): Promise<void> {
  const filePath = join(dataDir, LOGIN_STATE_FILE)

  await fs.promises.mkdir(dataDir, {mode: 0o700, recursive: true})
  await fs.promises.writeFile(filePath, JSON.stringify({account}) + '\n', {encoding: 'utf8', mode: 0o600})
}

export async function deleteLoginState(dataDir: string): Promise<void> {
  const filePath = join(dataDir, LOGIN_STATE_FILE)

  try {
    await fs.promises.unlink(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      credDebug('failed to delete login state file: %s', (error as Error).message)
    }
  }
}
