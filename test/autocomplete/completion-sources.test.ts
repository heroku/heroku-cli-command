import {Config} from '@oclif/core'
import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {CompletionContext} from '../../src/completion-types.js'

import {
  AddonCompletion,
  AppCompletion,
  BuildpackCompletion,
  completionCatalog,
  ConfigVarCompletion,
  DynoCompletion,
  DynoSizeCompletion,
  EnforcementActionCompletion,
  GenerationCompletion,
  PgNetworkCompletion,
  PipelineCompletion,
  ProcessTypeCompletion,
  RegionCompletion,
  ReleaseCompletion,
  RemoteCompletion,
  resetCompletionAuthClient,
  RoleCompletion,
  ScopeCompletion,
  SpaceCompletion,
  StackCompletion,
  StageCompletion,
  TeamCompletion,
} from '../../src/completions.js'
import {
  restoreCredentialManagerStub,
  stubCredentialManagerWithNoCredentials,
} from '../helpers/credential-manager-stub.js'
import {mockSDKPlatform} from '../helpers/mock-sdk.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Shapes a list of names into the `{name}` records the SDK list calls return. */
const named = (names: string[]) => names.map(name => ({name}))

/**
 * Exercises the completion value sources themselves — the `options`/`cacheKey`
 * closures in completions.ts — where the host CLI's inject/shell-exec tests only
 * cover the plumbing that wires them. The SDK-backed sources run against a
 * stubbed platform (no network), the local sources against a real Procfile and
 * git remote in a scratch cwd, and the static sources are asserted verbatim.
 */
describe('autocomplete completion sources', function () {
  this.timeout(120_000)

  let config: Config
  let ctx: CompletionContext

  before(async function () {
    config = await Config.load(path.resolve(__dirname, '..', '..'))
    ctx = {config}
  })

  describe('static completions (fixed value sets, no auth, no I/O)', function () {
    it('BuildpackCompletion offers the official buildpacks', function () {
      const values = BuildpackCompletion.options(ctx) as string[]
      expect(values).to.include('heroku/ruby').and.to.include('heroku/nodejs')
    })

    it('RoleCompletion offers the collaborator roles', function () {
      expect(RoleCompletion.options(ctx)).to.deep.equal(['admin', 'collaborator', 'member', 'owner'])
    })

    it('ScopeCompletion offers the authorization scopes', function () {
      expect(ScopeCompletion.options(ctx)).to.include('global').and.to.include('read-protected')
    })

    it('StageCompletion offers the pipeline stages', function () {
      expect(StageCompletion.options(ctx)).to.deep.equal(['test', 'review', 'development', 'staging', 'production'])
    })

    it('PgNetworkCompletion offers the data:pg:create --network values', function () {
      expect(PgNetworkCompletion.options(ctx)).to.deep.equal(['private', 'shield'])
    })

    it('GenerationCompletion offers the spaces:create --generation values', function () {
      expect(GenerationCompletion.options(ctx)).to.deep.equal(['cedar', 'fir'])
    })

    it('EnforcementActionCompletion offers the data:pg:quotas:update --enforcement-action values', function () {
      expect(EnforcementActionCompletion.options(ctx)).to.deep.equal(['notify', 'restrict', 'none'])
    })
  })

  describe('local-context completions (read cwd state, no auth, no network)', function () {
    let originalCwd: string
    let scratch: string

    beforeEach(function () {
      originalCwd = process.cwd()
      scratch = mkdtempSync(path.join(tmpdir(), 'heroku-ac-src-'))
      process.chdir(scratch)
    })

    afterEach(function () {
      process.chdir(originalCwd)
      rmSync(scratch, {force: true, recursive: true})
    })

    it('ProcessTypeCompletion reads the dyno types from a cwd Procfile', async function () {
      writeFileSync(path.join(scratch, 'Procfile'), 'web: node server.js\nworker: ./run\n\n')
      expect(await ProcessTypeCompletion.options(ctx)).to.deep.equal(['web', 'worker'])
    })

    it('ProcessTypeCompletion is empty when there is no Procfile', async function () {
      expect(await ProcessTypeCompletion.options(ctx)).to.deep.equal([])
    })

    it('RemoteCompletion lists the git remotes in the cwd repo', function () {
      execFileSync('git', ['init'], {cwd: scratch, stdio: 'ignore'})
      execFileSync('git', ['remote', 'add', 'heroku', 'https://git.heroku.com/x.git'], {cwd: scratch, stdio: 'ignore'})
      expect(RemoteCompletion.options(ctx)).to.deep.equal(['heroku'])
    })

    it('RemoteCompletion is empty outside a git repository', function () {
      // scratch is a bare temp dir with no .git; `git remote` exits non-zero.
      expect(RemoteCompletion.options(ctx)).to.deep.equal([])
    })
  })

  describe('SDK-backed completions (stubbed platform — no network)', function () {
    let restore: () => void

    beforeEach(function () {
      const platform = {
        addOn: {
          list: async () => named(['acct-redis-7', 'acct-pg-3']),
          listByApp: async (app: string) => (app === 'myapp' ? named(['redis-tapered-1', 'pg-curved-9']) : []),
        },
        app: {listOwnedAndCollaborated: async () => named(['charlie', 'alpha'])},
        configVar: {infoForApp: async (app: string) => (app === 'myapp' ? {A_SECRET: 'y', DATABASE_URL: 'x'} : {})},
        dyno: {list: async (app: string) => (app === 'myapp' ? named(['worker.1', 'web.1']) : [])},
        dynoSize: {list: async () => named(['Standard-1X', 'Performance-M'])},
        pipeline: {list: async () => named(['pipe'])},
        region: {list: async () => named(['us', 'eu'])},
        release: {list: async (app: string) => (app === 'myapp' ? [{version: 3}, {version: 1}, {version: 2}] : [])},
        space: {list: async () => named(['space'])},
        stack: {list: async () => named(['heroku-24', 'heroku-22'])},
        team: {list: async () => named(['team-b', 'team-a'])},
        withHeaders() {
          return this
        },
        withOptions() {
          return this
        },
      }
      restore = mockSDKPlatform(platform).restore
    })

    afterEach(function () {
      restore()
    })

    it('AppCompletion returns the account apps, sorted', async function () {
      expect(await AppCompletion.options(ctx)).to.deep.equal(['alpha', 'charlie'])
    })

    it('TeamCompletion returns the teams, sorted', async function () {
      expect(await TeamCompletion.options(ctx)).to.deep.equal(['team-a', 'team-b'])
    })

    it('PipelineCompletion returns the pipelines', async function () {
      expect(await PipelineCompletion.options(ctx)).to.deep.equal(['pipe'])
    })

    it('SpaceCompletion returns the spaces', async function () {
      expect(await SpaceCompletion.options(ctx)).to.deep.equal(['space'])
    })

    it('RegionCompletion returns the regions, sorted', async function () {
      expect(await RegionCompletion.options(ctx)).to.deep.equal(['eu', 'us'])
    })

    it('StackCompletion returns the stack names, sorted', async function () {
      expect(await StackCompletion.options(ctx)).to.deep.equal(['heroku-22', 'heroku-24'])
    })

    it('DynoSizeCompletion lower-cases and sorts the dyno sizes', async function () {
      expect(await DynoSizeCompletion.options(ctx)).to.deep.equal(['performance-m', 'standard-1x'])
    })

    it('DynoCompletion lists the dynos of the ctx app, sorted', async function () {
      expect(await DynoCompletion.options({app: 'myapp', config})).to.deep.equal(['web.1', 'worker.1'])
    })

    it('DynoCompletion offers nothing when no app is on the line', async function () {
      expect(await DynoCompletion.options(ctx)).to.deep.equal([])
    })

    it('AddonCompletion lists the ctx app add-ons, sorted', async function () {
      expect(await AddonCompletion.options({app: 'myapp', config})).to.deep.equal(['pg-curved-9', 'redis-tapered-1'])
    })

    it('AddonCompletion lists the account add-ons when no app is on the line (names are global)', async function () {
      // addons:rename and friends take a globally-unique add-on name with no --app,
      // so with no app context we complete the account's add-ons, not nothing.
      expect(await AddonCompletion.options(ctx)).to.deep.equal(['acct-pg-3', 'acct-redis-7'])
    })

    it('ReleaseCompletion lists the ctx app releases newest-first as vNNN', async function () {
      expect(await ReleaseCompletion.options({app: 'myapp', config})).to.deep.equal(['v3', 'v2', 'v1'])
    })

    it('ConfigVarCompletion lists the ctx app config var names, sorted', async function () {
      expect(await ConfigVarCompletion.options({app: 'myapp', config})).to.deep.equal(['A_SECRET', 'DATABASE_URL'])
    })

    it('the per-app positional completions offer nothing with no app on the line', async function () {
      // Releases and config vars are meaningful only within one app, so with no
      // app context they offer nothing. (Add-ons are the exception — their names
      // are global, so they fall back to the account-wide list; see above.)
      await Promise.all([ReleaseCompletion, ConfigVarCompletion].map(async completion => {
        expect(await completion.options(ctx)).to.deep.equal([])
      }))
    })
  })

  describe('when the user is not logged in', function () {
    // The memoized authed client is process-wide, so earlier specs leave a
    // resolved (authed) client behind. Reset it, point the credential manager at
    // "no credentials" (APIClient.getAuth → undefined), and clear any ambient
    // HEROKU_API_KEY so auth genuinely resolves to nothing on this run. The auth
    // path short-circuits before any network, so no platform stub is needed.
    let savedApiKey: string | undefined

    beforeEach(function () {
      savedApiKey = process.env.HEROKU_API_KEY
      delete process.env.HEROKU_API_KEY
      resetCompletionAuthClient()
      stubCredentialManagerWithNoCredentials()
    })

    afterEach(function () {
      restoreCredentialManagerStub()
      resetCompletionAuthClient()
      if (savedApiKey === undefined) delete process.env.HEROKU_API_KEY
      else process.env.HEROKU_API_KEY = savedApiKey
    })

    it('SDK-backed completions offer nothing instead of erroring', async function () {
      expect(await AppCompletion.options(ctx)).to.deep.equal([])
    })

    it('StackCompletion offers nothing instead of erroring', async function () {
      // No platform stub registered: the auth short-circuit returns [] before any
      // request. If it did not, the globally-disabled net would throw instead.
      expect(await StackCompletion.options(ctx)).to.deep.equal([])
    })
  })

  describe('cache keys', function () {
    it('account-scoped completions build an account+host cache key', async function () {
      // Dyno sizes are account-scoped too: the available set varies by account
      // entitlement, so the key must carry the token component.
      await Promise.all([AppCompletion, TeamCompletion, PipelineCompletion, SpaceCompletion, DynoSizeCompletion].map(async completion => {
        const key = await completion.cacheKey!(ctx)
        expect(key).to.match(/@api\.heroku\.com#/)
      }))
    })

    it('host-scoped completions build a host-only cache key (no token component)', async function () {
      await Promise.all([RegionCompletion, StackCompletion].map(async completion => {
        const key = await completion.cacheKey!(ctx)
        expect(key).to.match(/@api\.heroku\.com$/)
      }))
    })

    it('DynoCompletion partitions the cache by app so apps never share a dyno list', async function () {
      expect(await DynoCompletion.cacheKey!({app: 'myapp', config})).to.match(/dyno:myapp@api\.heroku\.com#/)
      const a = await DynoCompletion.cacheKey!({app: 'app-a', config})
      const b = await DynoCompletion.cacheKey!({app: 'app-b', config})
      expect(a).to.not.equal(b)
    })

    it('app-scoped positional completions partition the cache by app and carry the token', async function () {
      await Promise.all(([[AddonCompletion, 'addon'], [ReleaseCompletion, 'release'], [ConfigVarCompletion, 'configvar']] as const).map(async ([completion, kind]) => {
        expect(await completion.cacheKey!({app: 'myapp', config})).to.match(new RegExp(String.raw`${kind}:myapp@api\.heroku\.com#`))
        const a = await completion.cacheKey!({app: 'app-a', config})
        const b = await completion.cacheKey!({app: 'app-b', config})
        expect(a, `${kind} must not share a cache across apps`).to.not.equal(b)
      }))
    })
  })

  it('every catalog id resolves to a completion with an options source', function () {
    for (const [id, completion] of Object.entries(completionCatalog)) {
      expect(completion.options, `${id} must expose options`).to.be.a('function')
    }
  })
})
