import debug from 'debug'
import {execa, execaSync} from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type Token = MachineToken | {content: string, type: 'other'}
export type MachineToken = {
  comment?: string
  host: string
  internalWhitespace: string
  pre?: string
  props: {[key: string]: {comment?: string, value: string}}
  type: 'machine'
}

export type Machines = {
  [key: string]: {
    [key: string]: string | undefined
    account?: string
    login?: string
    password?: string
  }
}

export type MachinesWithTokens = Machines & {
  _tokens?: Token[]
}

const credDebug = debug('heroku-credential-manager')

/**
 * Creates ES6 proxy objects from parsed tokens to allow easy modification by consumers.
 * This is somewhat complicated, but it takes the array of parsed tokens from parse()
 * and wraps them in proxies that intercept get/set/delete operations.
 * @param tokens - Array of parsed tokens from the netrc file
 * @returns A proxied MachinesWithTokens object that allows direct property access and modification
 */
function proxify(tokens: Token[]): MachinesWithTokens {
  const proxifyProps = (t: MachineToken) => new Proxy(t.props as unknown as {[key: string]: string}, {
    get(_, key: string) {
      if (key === 'host') return t.host
      if (typeof key !== 'string') return t.props[key]
      const prop = t.props[key]
      if (!prop) return
      return prop.value
    },
    set(_, key: string, value: string) {
      if (key === 'host') {
        t.host = value
      } else if (value) {
        t.props[key] = t.props[key] || (t.props[key] = {value: ''})
        t.props[key].value = value
      } else {
        delete t.props[key]
      }

      return true
    },
  })
  const machineTokens = tokens.filter((m): m is MachineToken => m.type === 'machine')
  const machines = machineTokens.map(t => proxifyProps(t))
  const getWhitespace = () => {
    if (machineTokens.length === 0) return ' '
    return machineTokens.at(-1)!.internalWhitespace
  }

  const obj: MachinesWithTokens = {}
  obj._tokens = tokens
  for (const m of machines) obj[m.host] = m
  return new Proxy(obj, {
    deleteProperty(obj, host: string) {
      delete obj[host]
      const idx = tokens.findIndex(m => m.type === 'machine' && m.host === host)
      if (idx === -1) return true
      tokens.splice(idx, 1)
      return true
    },
    ownKeys() {
      return machines.map(m => m.host)
    },
    set(obj, host: string, props: {[key: string]: string}) {
      if (!props) {
        delete obj[host]
        const idx = tokens.findIndex(m => m.type === 'machine' && m.host === host)
        if (idx === -1) return true
        tokens.splice(idx, 1)
        return true
      }

      let machine = machines.find(m => m.host === host)
      if (!machine) {
        const token: MachineToken = {
          host, internalWhitespace: getWhitespace(), props: {}, type: 'machine',
        }
        tokens.push(token)
        machine = proxifyProps(token)
        machines.push(machine)
        obj[host] = machine
      }

      for (const [k, v] of Object.entries(props)) {
        machine[k] = v
      }

      return true
    },
  })
}

/**
 * Parses a netrc file body into a structured MachinesWithTokens object.
 * Handles both inline and multiline machine definitions, including comments.
 * @param body - The raw string content of a netrc file
 * @returns A proxied MachinesWithTokens object containing all parsed machine entries
 */
export function parse(body: string): MachinesWithTokens {
  const lines = body.split('\n')
  let pre: string[] = []
  const machines: MachineToken[] = []
  while (lines.length > 0) {
    const line = lines.shift()!
    const match = line.match(/machine\s+((?:[^\s#]+\s*)+)(#.*)?$/)
    if (!match) {
      pre.push(line)
      continue
    }

    const [, body, comment] = match
    const machine: MachineToken = {
      comment,
      host: body.split(' ')[0],
      internalWhitespace: '\n  ',
      pre: pre.join('\n'),
      props: {},
      type: 'machine',
    }
    pre = []
    // do not read other machines with same host
    if (!machines.some(m => m.type === 'machine' && m.host === machine.host)) machines.push(machine)
    if (body.trim().includes(' ')) { // inline machine
      const [host, ...propStrings] = body.split(' ')
      for (let a = 0; a < propStrings.length; a += 2) {
        machine.props[propStrings[a]] = {value: propStrings[a + 1]}
      }

      machine.host = host
      machine.internalWhitespace = ' '
    } else { // multiline machine
      while (lines.length > 0) {
        const line = lines.shift()!
        const match = line.match(/^(\s+)(\S+)\s+(\S+)(\s+#.*)?$/)
        if (!match) {
          lines.unshift(line)
          break
        }

        const [, ws, key, value, comment] = match
        machine.props[key] = {comment, value}
        machine.internalWhitespace = `\n${ws}`
      }
    }
  }

  return proxify([...machines, {content: pre.join('\n'), type: 'other'}])
}

export class Netrc {
  file: string
  machines!: MachinesWithTokens

  /**
   * Creates a new Netrc instance.
   * @param file - Optional path to the netrc file. If not provided, uses the default location.
   */
  constructor(file?: string) {
    this.file = file || this.defaultFile
  }

  /**
   * Gets the default netrc file path based on the operating system.
   * Checks for GPG-encrypted version first.
   * @returns The path to the default netrc file
   */
  private get defaultFile(): string {
    let home: string | undefined
    if (os.platform() === 'win32') {
      const fromDrive
        = process.env.HOMEDRIVE && process.env.HOMEPATH
          ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
          : undefined
      home = process.env.HOME || fromDrive || process.env.USERPROFILE
    }

    const resolved = home || os.homedir() || os.tmpdir()
    const file = path.join(
      resolved,
      os.platform() === 'win32' ? '_netrc' : '.netrc',
    )
    const gpgFile = `${file}.gpg`
    return fs.existsSync(gpgFile) ? gpgFile : file
  }

  /**
   * Gets the GPG command arguments for decrypting the netrc file.
   * @returns Array of GPG command-line arguments for decryption
   */
  private get gpgDecryptArgs() {
    const args = ['--batch', '--quiet', '--decrypt', this.file]
    credDebug('running gpg with args %o', args)
    return args
  }

  /**
   * Gets the GPG command arguments for encrypting the netrc file.
   * @returns Array of GPG command-line arguments for encryption
   */
  private get gpgEncryptArgs() {
    const args = ['-a', '--batch', '--default-recipient-self', '-e']
    credDebug('running gpg with args %o', args)
    return args
  }

  /**
   * Generates the string representation of all machines for writing to file.
   * @returns The formatted netrc file content as a string
   */
  private get output(): string {
    const output: string[] = []
    if (this.machines._tokens) {
      for (const t of this.machines._tokens as Token[]) {
        if (t.type === 'other') {
          output.push(t.content)
          continue
        }

        if (t.pre) {
          output.push(t.pre + '\n')
        }

        output.push(`machine ${t.host}`)

        if (t.internalWhitespace.includes('\n')) {
          this.addCommentToOutput(t, output)
          this.addPropsToOutput(t, output)
          output.push('\n')
        } else {
          this.addPropsToOutput(t, output)
          this.addCommentToOutput(t, output)
          output.push('\n')
        }
      }
    }

    return output.join('')
  }

  /**
   * Asynchronously loads and parses the netrc file.
   * Handles both plain text and GPG-encrypted files.
   * @returns A promise that resolves when loading is complete, or throws on error
   */
  async load(): Promise<never | void> {
    try {
      credDebug('load', this.file)
      const decryptFile = async (): Promise<string> => {
        const {exitCode, stdout} = await execa('gpg', this.gpgDecryptArgs, {reject: false, stdio: ['inherit', 'pipe', 'inherit']})
        if (exitCode !== 0) throw new Error(`gpg exited with code ${exitCode}`)
        return stdout
      }

      const body = await (path.extname(this.file) === '.gpg'
        ? decryptFile()
        : new Promise<string>((resolve, reject) => {
          fs.readFile(this.file, {encoding: 'utf8'}, (err, data) => {
            if (err && err.code !== 'ENOENT') reject(err)
            debug('ENOENT')
            resolve(data || '')
          })
        }))
      this.machines = parse(body)
      credDebug('machines: %o', Object.keys(this.machines))
    } catch (error) {
      return this.throw(error)
    }
  }

  /**
   * Synchronously loads and parses the netrc file.
   * Handles both plain text and GPG-encrypted files.
   * @returns void, or throws on error
   */
  loadSync(): never | void {
    try {
      credDebug('loadSync', this.file)
      const decryptFile = (): string => {
        const {exitCode, stdout} = execaSync('gpg', this.gpgDecryptArgs, {reject: false, stdio: ['inherit', 'pipe', 'inherit']})
        if (exitCode !== 0) throw new Error(`gpg exited with code ${exitCode}`)
        return stdout
      }

      let body = ''
      if (path.extname(this.file) === '.gpg') {
        body = decryptFile()
      } else {
        try {
          body = fs.readFileSync(this.file, 'utf8')
        } catch (error: unknown) {
          if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') throw error
        }
      }

      this.machines = parse(body)
      credDebug('machines: %o', Object.keys(this.machines))
    } catch (error) {
      return this.throw(error)
    }
  }

  /**
   * Asynchronously saves the current machines to the netrc file.
   * Handles GPG encryption if the file has a .gpg extension.
   * @returns A promise that resolves when saving is complete
   */
  async save() {
    credDebug('save', this.file)
    let body = this.output
    if (this.file.endsWith('.gpg')) {
      const {exitCode, stdout} = await execa('gpg', this.gpgEncryptArgs, {input: body, reject: false, stdio: ['pipe', 'pipe', 'inherit']})
      if (exitCode !== 0) throw new Error(`gpg exited with code ${exitCode}`)
      body = stdout
    }

    return new Promise<void>((resolve, reject) => {
      fs.writeFile(this.file, body, {mode: 0o600}, err => (err ? reject(err) : resolve()))
    })
  }

  /**
   * Synchronously saves the current machines to the netrc file.
   * Handles GPG encryption if the file has a .gpg extension.
   * @returns void, or throws on error
   */
  saveSync() {
    credDebug('saveSync', this.file)
    let body = this.output
    if (this.file.endsWith('.gpg')) {
      const {exitCode, stdout} = execaSync('gpg', this.gpgEncryptArgs, {input: body, reject: false, stdio: ['pipe', 'pipe', 'inherit']})
      if (exitCode !== 0) throw new Error(`gpg exited with code ${exitCode}`)
      body = stdout
    }

    fs.writeFileSync(this.file, body, {mode: 0o600})
  }

  /**
   * Appends a machine token's comment to the output array.
   * @param t - The machine token containing the comment
   * @param output - The output string array to append to
   * @returns void
   */
  private addCommentToOutput(t: MachineToken, output: string[]) {
    if (t.comment) output.push(' ' + t.comment)
  }

  /**
   * Appends a machine token's properties to the output array.
   * Login and password are added first, followed by other properties.
   * @param t - The machine token containing the properties
   * @param output - The output string array to append to
   * @returns void
   */
  private addPropsToOutput(t: MachineToken, output: string[]) {
    const addProp = (k: string) => output.push(`${t.internalWhitespace}${k} ${t.props[k].value}${t.props[k].comment || ''}`)
    // do login/password first
    if (t.props.login) addProp('login')
    if (t.props.password) addProp('password')
    for (const k of Object.keys(t.props).filter(k => !['login', 'password'].includes(k))) {
      addProp(k)
    }
  }

  /**
   * Wraps and throws an error with additional context about the netrc file.
   * @param err - The original error
   * @returns Never returns; always throws
   */
  private throw(err: unknown): never {
    const error = (err instanceof Error ? err : new Error(String(err))) as Error & {detail?: string}
    if (error.detail) error.detail += '\n'
    else error.detail = ''
    error.detail += `Error occurred during reading netrc file: ${this.file}`
    throw error
  }
}

export default new Netrc()
