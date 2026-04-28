import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import {join} from 'node:path'
import sinon from 'sinon'

import {deleteLoginState, readLoginState, writeLoginState} from '../../../src/credential-manager-core/lib/login-state.js'

describe('login-state', function () {
  let tmpDir: string

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'heroku-login-state-'))
  })

  afterEach(function () {
    fs.rmSync(tmpDir, {force: true, recursive: true})
    sinon.restore()
  })

  describe('readLoginState', function () {
    it('returns undefined when file does not exist', function () {
      expect(readLoginState(tmpDir)).to.be.undefined
    })

    it('reads a valid login state file', function () {
      fs.writeFileSync(join(tmpDir, 'login.json'), JSON.stringify({account: 'user@example.com'}))
      const result = readLoginState(tmpDir)
      expect(result).to.deep.equal({account: 'user@example.com'})
    })

    it('returns undefined for malformed JSON', function () {
      fs.writeFileSync(join(tmpDir, 'login.json'), 'not json')
      expect(readLoginState(tmpDir)).to.be.undefined
    })

    it('returns undefined when account field is missing', function () {
      fs.writeFileSync(join(tmpDir, 'login.json'), JSON.stringify({other: 'field'}))
      expect(readLoginState(tmpDir)).to.be.undefined
    })

    it('returns undefined when account is empty string', function () {
      fs.writeFileSync(join(tmpDir, 'login.json'), JSON.stringify({account: ''}))
      expect(readLoginState(tmpDir)).to.be.undefined
    })

    it('returns undefined when account is not a string', function () {
      fs.writeFileSync(join(tmpDir, 'login.json'), JSON.stringify({account: 123}))
      expect(readLoginState(tmpDir)).to.be.undefined
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

    it('sets file permissions to 0o600', async function () {
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
