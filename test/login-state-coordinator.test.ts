import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as sinon from 'sinon'

import {readLoginState} from '../src/credential-manager-core/lib/login-state.js'
import {
  deleteLoginStateCoordinated,
  deleteLoginStateIf,
  getLoginStateRevision,
  withLoginStateCoordination,
  writeLoginStateCoordinated,
} from '../src/login-state-coordinator.js'

function deferred<T = void>() {
  return Promise.withResolvers<T>()
}

describe('login-state coordinator', () => {
  let otherDir: string
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heroku-login-state-coordinator-'))
    otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heroku-login-state-coordinator-other-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, {force: true, recursive: true})
    fs.rmSync(otherDir, {force: true, recursive: true})
  })

  it('serializes one normalized dataDir in invocation order while another dataDir proceeds', async () => {
    const lockHeld = deferred()
    const releaseLock = deferred()
    const first = withLoginStateCoordination(path.join(tmpDir, '.'), async () => {
      lockHeld.resolve()
      await releaseLock.promise
    })
    await lockHeld.promise

    const write = writeLoginStateCoordinated(tmpDir, 'queued@example.com')
    const remove = deleteLoginStateCoordinated(path.resolve(tmpDir))
    await writeLoginStateCoordinated(otherDir, 'parallel@example.com')

    expect(await readLoginState(tmpDir)).to.be.undefined
    expect(await readLoginState(otherDir)).to.deep.equal({account: 'parallel@example.com'})

    releaseLock.resolve()
    await Promise.all([first, write, remove])
    expect(await readLoginState(tmpDir)).to.be.undefined
  })

  it('skips conditional deletion for an account mismatch, changed revision, or newer APIClient generation', async () => {
    await writeLoginStateCoordinated(tmpDir, 'current@example.com')
    let generation = 1
    const accountMismatchRevision = await getLoginStateRevision(tmpDir)

    const accountMismatch = await deleteLoginStateIf(
      tmpDir,
      accountMismatchRevision,
      state => state?.account === 'stale@example.com' && generation === 1,
    )
    expect(accountMismatch).to.equal(false)

    const changedRevision = await getLoginStateRevision(tmpDir)
    await writeLoginStateCoordinated(tmpDir, 'newer@example.com')
    expect(await deleteLoginStateIf(tmpDir, changedRevision, () => true)).to.equal(false)

    const expectedGeneration = generation
    generation++
    const newerGenerationRevision = await getLoginStateRevision(tmpDir)
    const newerGeneration = await deleteLoginStateIf(
      tmpDir,
      newerGenerationRevision,
      state => state?.account === 'newer@example.com' && generation === expectedGeneration,
    )
    expect(newerGeneration).to.equal(false)
    expect(await readLoginState(tmpDir)).to.deep.equal({account: 'newer@example.com'})
  })

  it('continues the FIFO after an operation rejects', async () => {
    const failure = new Error('coordinated operation failed')
    const rejected = withLoginStateCoordination(tmpDir, async () => {
      throw failure
    })
    const write = writeLoginStateCoordinated(tmpDir, 'recovered@example.com')

    expect(await rejected.catch((error: unknown) => error)).to.equal(failure)
    await write
    expect(await readLoginState(tmpDir)).to.deep.equal({account: 'recovered@example.com'})
  })

  it('increments the shared normalized-key revision only after successful package mutations', async () => {
    const initialRevision = (await getLoginStateRevision(path.join(tmpDir, '.'))).revision
    await writeLoginStateCoordinated(tmpDir, 'revision@example.com')
    const writtenRevision = (await getLoginStateRevision(path.resolve(tmpDir))).revision
    expect(writtenRevision).to.equal(initialRevision + 1)

    const writeFailure = new Error('write failed')
    const write = sinon.stub(fs.promises, 'mkdir').rejects(writeFailure)
    try {
      expect(await writeLoginStateCoordinated(tmpDir, 'failed@example.com').catch((error: unknown) => error)).to.equal(writeFailure)
      expect((await getLoginStateRevision(tmpDir)).revision).to.equal(writtenRevision)
    } finally {
      write.restore()
    }

    const deleteFailure = new Error('delete failed')
    const unlink = sinon.stub(fs.promises, 'unlink').rejects(deleteFailure)
    try {
      await deleteLoginStateCoordinated(tmpDir)
      expect((await getLoginStateRevision(tmpDir)).revision).to.equal(writtenRevision)
      expect(await readLoginState(tmpDir)).to.deep.equal({account: 'revision@example.com'})
    } finally {
      unlink.restore()
    }

    await deleteLoginStateCoordinated(tmpDir)
    expect((await getLoginStateRevision(tmpDir)).revision).to.equal(writtenRevision + 1)
  })

  it('retains revisions after idle queue cleanup for the process-lifetime normalized key', async () => {
    await writeLoginStateCoordinated(tmpDir, 'before@example.com')
    const beforeRemoval = await getLoginStateRevision(tmpDir)
    fs.rmSync(tmpDir, {force: true, recursive: true})

    expect(await getLoginStateRevision(path.join(tmpDir, '.'))).to.deep.equal(beforeRemoval)

    await writeLoginStateCoordinated(tmpDir, 'after@example.com')
    expect((await getLoginStateRevision(tmpDir)).revision).to.equal(beforeRemoval.revision + 1)
  })

  it('does not increment revision when package deletion finds no login state to mutate', async () => {
    const beforeDelete = await getLoginStateRevision(tmpDir)

    await deleteLoginStateCoordinated(tmpDir)

    expect(await getLoginStateRevision(tmpDir)).to.deep.equal(beforeDelete)
  })

  it('uses the original normalized configured dataDir for package I/O', async () => {
    const configuredDataDir = path.join(tmpDir, 'nested', '..')
    await writeLoginStateCoordinated(configuredDataDir, 'normalized@example.com')

    expect(await readLoginState(path.resolve(configuredDataDir))).to.deep.equal({account: 'normalized@example.com'})
  })

  it('retains the package direct-symlink write protection', async function () {
    if (process.platform === 'win32') this.skip()
    const alias = `${tmpDir}-alias`
    fs.symlinkSync(tmpDir, alias, 'dir')
    const revision = await getLoginStateRevision(alias)

    try {
      const error = await writeLoginStateCoordinated(alias, 'blocked@example.com').catch((error: unknown) => error) as NodeJS.ErrnoException
      expect(error.code).to.equal('ENOTDIR')
      expect(await getLoginStateRevision(alias)).to.deep.equal(revision)
      expect(await readLoginState(tmpDir)).to.be.undefined
    } finally {
      fs.rmSync(alias, {force: true})
    }
  })
})
