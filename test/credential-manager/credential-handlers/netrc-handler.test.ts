import {expect, use} from 'chai'
import chaiAsPromised from 'chai-as-promised'
import fs from 'fs-extra'
import {resolve} from 'node:path'

import {MachineToken} from '../../../src/credential-manager-core/lib/netrc-parser.js'

use(chaiAsPromised)

import {NetrcHandler} from '../../../src/credential-manager-core/credential-handlers/netrc-handler.js'
import {restoreNetrcStub, stubNetrc} from '../helpers/netrc-stub.js'

describe('NetrcHandler', function () {
  beforeEach(stubNetrc)

  afterEach(restoreNetrcStub)

  describe('get auth', function () {
    it('should get auth for a specified host', async function () {
      const handler = new NetrcHandler()
      const auth = await handler.getAuth('api.heroku.com')
      expect(auth).to.deep.equal({login: 'test@example.com', password: 'mypass'})
    })

    it('should error if no auth is saved for the specified host', async function () {
      const handler = new NetrcHandler()
      await expect(handler.getAuth('fake.heroku.com')).to.be.rejectedWith('No auth found for fake.heroku.com')
    })
  })

  describe('remove auth', function () {
    it('should remove auth for a specified host', async function () {
      const handler = new NetrcHandler()
      await handler.removeAuth('api.heroku.com')
      expect(handler.netrc.machines['api.heroku.com']).to.be.undefined
    })

    it('should do nothing if no auth is saved for the specified host', async function () {
      const handler = new NetrcHandler()
      await handler.removeAuth('fake.heroku.com')
      expect(handler.netrc.machines['fake.heroku.com']).to.be.undefined
    })
  })

  describe('save auth', function () {
    it('should save auth for a specified host', async function () {
      const handler = new NetrcHandler()
      await handler.saveAuth({login: 'test@example.com', password: 'mypass'}, 'new.heroku.com')
      expect(handler.netrc.machines['new.heroku.com']).to.deep.equal({login: 'test@example.com', password: 'mypass'})
    })

    it('should remove method and org entries for the specified host if present', async function () {
      const handler = new NetrcHandler()
      await handler.saveAuth({login: 'test@example.com', password: 'mypass'}, 'api.heroku.com')
      handler.netrc.machines['api.heroku.com'].method = 'gpg'
      handler.netrc.machines['api.heroku.com'].org = 'test'
      await handler.saveAuth({login: 'test@example.com', password: 'mypass'}, 'api.heroku.com')
      expect(handler.netrc.machines['api.heroku.com']).to.deep.equal({login: 'test@example.com', password: 'mypass'})
      expect(handler.netrc.machines['api.heroku.com'].method).to.be.undefined
      expect(handler.netrc.machines['api.heroku.com'].org).to.be.undefined
    })

    it('adds internal-whitespace value if _tokens array is present for specified host', async function () {
      const handler = new NetrcHandler()
      await handler.saveAuth({login: 'test@example.com', password: 'mypass'}, 'api.heroku.com')
      handler.netrc.machines._tokens = [{host: 'api.heroku.com', props: {}, type: 'machine'}] as MachineToken[]
      await handler.saveAuth({login: 'test@example.com', password: 'mypass'}, 'api.heroku.com')
      expect((handler.netrc.machines._tokens[0] as MachineToken).internalWhitespace).to.equal('\n  ')
    })
  })

  describe('batch netrc (temp file, no prototype stub)', function () {
    const tmpDir = resolve('tmp/netrc-handler-batch')
    let netrcPath: string

    beforeEach(async function () {
      await fs.mkdirp(tmpDir)
      netrcPath = resolve(tmpDir, `n-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      await fs.writeFile(netrcPath, '', 'utf8')
    })

    afterEach(async function () {
      await fs.remove(tmpDir)
    })

    it('saveAuthForHosts writes multiple hosts with a single save', async function () {
      let saveCalls = 0
      const handler = new NetrcHandler(netrcPath)
      const origSave = handler.netrc.save.bind(handler.netrc)
      handler.netrc.save = async () => {
        saveCalls++
        return origSave()
      }

      await handler.saveAuthForHosts({login: 'u@e.com', password: 'tok'}, ['a.com', 'b.com'])
      expect(saveCalls).to.equal(1)
      expect(handler.netrc.machines['a.com']).to.deep.equal({login: 'u@e.com', password: 'tok'})
      expect(handler.netrc.machines['b.com']).to.deep.equal({login: 'u@e.com', password: 'tok'})
    })

    it('removeAuthForHosts removes multiple hosts with a single save', async function () {
      let saveCalls = 0
      const handler = new NetrcHandler(netrcPath)
      await handler.saveAuthForHosts({login: 'u@e.com', password: 'tok'}, ['api.heroku.com', 'git.heroku.com'])

      const origSave = handler.netrc.save.bind(handler.netrc)
      handler.netrc.save = async () => {
        saveCalls++
        return origSave()
      }

      await handler.removeAuthForHosts(['api.heroku.com', 'git.heroku.com'])
      expect(saveCalls).to.equal(1)
      expect(handler.netrc.machines['api.heroku.com']).to.be.undefined
      expect(handler.netrc.machines['git.heroku.com']).to.be.undefined
    })
  })
})
