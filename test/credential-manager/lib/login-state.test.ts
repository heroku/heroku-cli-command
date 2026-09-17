import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import {join, relative} from 'node:path'
import sinon from 'sinon'

import {
  deleteLoginState,
  loginStateDataDir,
  readLoginState,
  writeLoginState,
} from '../../../src/credential-manager-core/lib/login-state.js'

const skipOnWindows = process.platform === 'win32' ? it.skip : it

describe('login-state', function () {
  let tmpDir: string

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'heroku-login-state-'))
  })

  afterEach(function () {
    fs.rmSync(tmpDir, {force: true, recursive: true})
    sinon.restore()
  })

  describe('loginStateDataDir', function () {
    it('keeps canonical production state at the historical global path', function () {
      expect(loginStateDataDir(tmpDir, 'api.heroku.com', 'heroku-cli')).to.equal(tmpDir)
    })

    it('derives a stable traversal-safe directory from the exact custom scope', function () {
      const service = 'heroku-cli@../../api.staging.heroku.com:8443'
      const scoped = loginStateDataDir(tmpDir, 'api.staging.heroku.com:8443', service)
      const relativePath = relative(tmpDir, scoped)

      expect(scoped).to.equal(loginStateDataDir(tmpDir, 'api.staging.heroku.com:8443', service))
      expect(relativePath).to.match(/^login-state[/\\][\da-f]{64}$/)
      expect(relativePath).to.not.include('..')
      expect(scoped).to.not.equal(loginStateDataDir(tmpDir, 'api.staging.heroku.com:8444', service))
      expect(scoped).to.not.equal(loginStateDataDir(tmpDir, 'api.staging.heroku.com:8443', `${service}-other`))
    })

    it('uses the login-state format and permissions for scoped custom state', async function () {
      const scoped = loginStateDataDir(tmpDir, '[::1]:8443', 'heroku-cli@[::1]:8443')

      await writeLoginState(scoped, 'custom@example.com')

      expect(await readLoginState(scoped)).to.deep.equal({account: 'custom@example.com'})
      expect(JSON.parse(fs.readFileSync(join(scoped, 'login.json'), 'utf8'))).to.deep.equal({account: 'custom@example.com'})
      if (process.platform !== 'win32') {
        // eslint-disable-next-line no-bitwise
        expect(fs.statSync(scoped).mode & 0o777).to.equal(0o700)
        // eslint-disable-next-line no-bitwise
        expect(fs.statSync(join(scoped, 'login.json')).mode & 0o777).to.equal(0o600)
      }
    })
  })

  describe('readLoginState', function () {
    it('returns undefined when file does not exist', async function () {
      expect(await readLoginState(tmpDir)).to.be.undefined
    })

    it('reads a valid login state file', async function () {
      fs.writeFileSync(join(tmpDir, 'login.json'), JSON.stringify({account: 'user@example.com'}))
      const result = await readLoginState(tmpDir)
      expect(result).to.deep.equal({account: 'user@example.com'})
    })

    it('returns undefined for malformed JSON', async function () {
      fs.writeFileSync(join(tmpDir, 'login.json'), 'not json')
      expect(await readLoginState(tmpDir)).to.be.undefined
    })

    it('returns undefined when account field is missing', async function () {
      fs.writeFileSync(join(tmpDir, 'login.json'), JSON.stringify({other: 'field'}))
      expect(await readLoginState(tmpDir)).to.be.undefined
    })

    it('returns undefined when account is empty string', async function () {
      fs.writeFileSync(join(tmpDir, 'login.json'), JSON.stringify({account: ''}))
      expect(await readLoginState(tmpDir)).to.be.undefined
    })

    it('returns undefined when account is not a string', async function () {
      fs.writeFileSync(join(tmpDir, 'login.json'), JSON.stringify({account: 123}))
      expect(await readLoginState(tmpDir)).to.be.undefined
    })
  })

  describe('writeLoginState', function () {
    it('creates the file with the account', async function () {
      await writeLoginState(tmpDir, 'user@example.com')
      const content = JSON.parse(fs.readFileSync(join(tmpDir, 'login.json'), 'utf8'))
      expect(content).to.deep.equal({account: 'user@example.com'})
    })

    it('creates the directory if it does not exist', async function () {
      const nestedDir = join(tmpDir, 'nested', 'dir')
      await writeLoginState(nestedDir, 'user@example.com')
      const content = JSON.parse(fs.readFileSync(join(nestedDir, 'login.json'), 'utf8'))
      expect(content).to.deep.equal({account: 'user@example.com'})
    })

    it('overwrites an existing file', async function () {
      await writeLoginState(tmpDir, 'old@example.com')
      await writeLoginState(tmpDir, 'new@example.com')
      const content = JSON.parse(fs.readFileSync(join(tmpDir, 'login.json'), 'utf8'))
      expect(content).to.deep.equal({account: 'new@example.com'})
    })

    skipOnWindows('sets file permissions to 0o600', async function () {
      await writeLoginState(tmpDir, 'user@example.com')
      const stats = fs.statSync(join(tmpDir, 'login.json'))
      // eslint-disable-next-line no-bitwise
      expect(stats.mode & 0o777).to.equal(0o600)
    })
  })

  describe('deleteLoginState', function () {
    it('deletes the login state file', async function () {
      fs.writeFileSync(join(tmpDir, 'login.json'), JSON.stringify({account: 'user@example.com'}))
      await deleteLoginState(tmpDir)
      expect(fs.existsSync(join(tmpDir, 'login.json'))).to.be.false
    })

    it('does not throw when file does not exist', async function () {
      await deleteLoginState(tmpDir)
    })

    it('does not delete other files in the directory', async function () {
      fs.writeFileSync(join(tmpDir, 'other.json'), 'keep')
      fs.writeFileSync(join(tmpDir, 'login.json'), JSON.stringify({account: 'user@example.com'}))
      await deleteLoginState(tmpDir)
      expect(fs.existsSync(join(tmpDir, 'other.json'))).to.be.true
    })
  })
})
