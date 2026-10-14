import {Plugin} from '@oclif/core'
import {expect} from 'fancy-test'
import {fileURLToPath} from 'node:url'

const envVars = ['HEROKU_APP', 'HEROKU_ORGANIZATION', 'HEROKU_TEAM']

describe('manifest generation', () => {
  const fixtureRoot = fileURLToPath(new URL('../fixtures/env-default-flags-plugin', import.meta.url))
  const cachedDefault = async (flag: string, respectNoCacheDefault: boolean) => {
    const plugin = new Plugin({ignoreManifest: true, respectNoCacheDefault, root: fixtureRoot})
    await plugin.load()
    return plugin.manifest.commands.demo.flags[flag].default
  }

  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = Object.fromEntries(envVars.map(name => [name, process.env[name]]))
    process.env.HEROKU_APP = 'my-local-app'
    process.env.HEROKU_ORGANIZATION = 'my-local-org'
    process.env.HEROKU_TEAM = 'my-local-team'
  })

  afterEach(() => {
    for (const name of envVars) {
      if (originalEnv[name] === undefined) delete process.env[name]
      else process.env[name] = originalEnv[name]
    }
  })

  const flagsWithEnvDefaults = [
    {flag: 'app', value: 'my-local-app'},
    {flag: 'org', value: 'my-local-org'},
    {flag: 'team', value: 'my-local-team'},
  ]

  for (const {flag, value} of flagsWithEnvDefaults) {
    describe(`--${flag}`, () => {
      it('caches the local default when generating at runtime', async () => {
        expect(await cachedDefault(flag, false)).to.equal(value)
      })

      it('keeps the local default out of generated docs and manifests', async () => {
        expect(await cachedDefault(flag, true)).to.be.undefined
      })
    })
  }
})
