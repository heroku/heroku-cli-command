import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(fileURLToPath(new URL('../..', import.meta.url)))
const workflowNames = [
  'ci.yml',
  'ci-acceptance.yml',
  'pr-title-check.yml',
  'release-on-push.yml',
  'release.yml',
  'update-release-configs.yml',
]
const packedVerifierPath = 'scripts/verify-packed-consumer.mjs'
const rollbackVerifierPath = 'scripts/verify-credential-manager-rollback.mjs'
const npmSetupJobs = [
  ['ci.yml', 'lint', 'node scripts/public-npm-config.mjs', 'node scripts/public-npm-config.mjs cleanup', 'npm ci --ignore-scripts'],
  ['ci.yml', 'test', 'node scripts/public-npm-config.mjs', 'node scripts/public-npm-config.mjs cleanup', 'npm ci --ignore-scripts'],
  ['ci.yml', 'verifiers', 'node scripts/public-npm-config.mjs', 'node scripts/public-npm-config.mjs cleanup', 'npm ci --ignore-scripts'],
  ['ci-acceptance.yml', 'acceptance', 'node scripts/public-npm-config.mjs', 'node scripts/public-npm-config.mjs cleanup', 'npm ci --ignore-scripts'],
  ['release.yml', 'validate', 'node scripts/public-npm-config.mjs', 'node scripts/public-npm-config.mjs cleanup', 'npm ci --ignore-scripts'],
  ['release.yml', 'build-package', 'node scripts/public-npm-config.mjs', 'node scripts/public-npm-config.mjs cleanup', 'npm ci --ignore-scripts'],
  ['release.yml', 'publish', 'node trusted-release-workflow/scripts/public-npm-config.mjs setup', 'node trusted-release-workflow/scripts/public-npm-config.mjs cleanup', 'npm install --global --ignore-scripts --no-audit --no-fund "npm@$EXPECTED_NPM_VERSION"'],
]
const read = (name, base = root) => readFileSync(join(base, name), 'utf8')
const githubExpressionStart = String.fromCodePoint(36) + '{{'
const githubAppToken = `${githubExpressionStart} steps.app-token.outputs.token }}`

function copyTree(source, target) {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target)
    return
  }

  if (!stat.isDirectory()) {
    copyFileSync(source, target)
    return
  }

  mkdirSync(target, {recursive: true})
  for (const entry of readdirSync(source)) {
    copyTree(join(source, entry), join(target, entry))
  }
}

function parseWorkflow(workflowText, name) {
  const ruby = `
require 'yaml'
require 'json'
source = STDIN.read
document = YAML.parse(source)
check = lambda do |node|
  if node.is_a?(Psych::Nodes::Mapping)
    keys = node.children.each_slice(2).map { |key, _| key.value }
    abort 'duplicate YAML key' unless keys.uniq == keys
  end
  Array(node.children).each { |child| check.call(child) } if node.respond_to?(:children)
end
check.call(document)
puts JSON.generate(YAML.safe_load(source, aliases: false))
`
  const result = spawnSync('ruby', ['-e', ruby], {encoding: 'utf8', input: workflowText})
  assert.equal(result.status, 0, `${name} is invalid/ambiguous YAML: ${result.stderr.trim()}`)
  return JSON.parse(result.stdout)
}

function splitTopLevel(expression, operator) {
  const parts = []
  let depth = 0
  let quote
  let start = 0
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index]
    if (quote) {
      if (character === quote && expression[index - 1] !== '\\') quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (depth === 0 && expression.startsWith(operator, index)) {
      parts.push(expression.slice(start, index))
      start = index + operator.length
      index += operator.length - 1
    }
  }
  parts.push(expression.slice(start))
  return parts
}

function stripOuterParentheses(expression) {
  let result = expression.trim()
  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0
    let quote
    let wrapsWholeExpression = true
    for (let index = 0; index < result.length; index += 1) {
      const character = result[index]
      if (quote) {
        if (character === quote && result[index - 1] !== '\\') quote = undefined
        continue
      }
      if (character === "'" || character === '"') quote = character
      if (character === '(') depth += 1
      if (character === ')') depth -= 1
      if (depth === 0 && index < result.length - 1) {
        wrapsWholeExpression = false
        break
      }
    }
    if (!wrapsWholeExpression) break
    result = result.slice(1, -1).trim()
  }
  return result
}

function normalizeExpression(expression) {
  return stripOuterParentheses(expression).replaceAll(/\s+/g, '')
}

function conjuncts(expression) {
  const stripped = stripOuterParentheses(expression)
  const parts = splitTopLevel(stripped, '&&')
  return parts.length > 1 ? parts.flatMap(conjuncts) : [normalizeExpression(stripped)]
}

function requireJobGuards(job, workflowName, jobName, eventName) {
  const terms = conjuncts(job?.if ?? '')
  const required = [
    "github.repository=='heroku/heroku-cli-command'",
    "vars.CREDENTIAL_MANAGER_INSTALL_ENABLED=='true'",
    `github.event_name=='${eventName}'`,
    "(github.ref=='refs/heads/main'||github.ref=='refs/heads/beta')",
  ].map(normalizeExpression)
  for (const term of required) {
    assert.ok(terms.includes(term), `${workflowName}:${jobName} must conjunctively require ${term}`)
  }
}

function assertPermissions(actual, expected, context) {
  assert.deepEqual(actual, expected, `${context} permissions must be exactly ${JSON.stringify(expected)}`)
}

function countOccurrences(text, value) {
  return (text.split(value).length - 1)
}

function requireNpmConfigurationSequence(configuration, job) {
  const [workflowName, jobName, setupCommand, cleanupCommand, dependencyCommand] = configuration
  const steps = job?.steps ?? []
  const context = `${workflowName}:${jobName}`
  const setupSteps = steps.filter(step => step.run?.trim() === setupCommand)
  assert.equal(setupSteps.length, 1, `${context} must prepare isolated public npm configuration exactly once`)
  const escapedSetupCommand = setupCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const setupInvocation = new RegExp(`${escapedSetupCommand}(?=\\s*(?:$|&&|\\|\\||;|\\n))`, 'gm')
  const setupInvocations = steps.reduce((count, step) => count + ((step.run ?? '').match(setupInvocation) ?? []).length, 0)
  assert.equal(setupInvocations, 1, `${context} must invoke isolated public npm configuration setup exactly once`)
  const setupIndex = steps.indexOf(setupSteps[0])
  assert.equal(setupSteps[0]?.if, undefined, `${context} npm configuration setup must not be conditional`)

  const dependencySteps = steps.filter(step => step.run?.trim() === dependencyCommand)
  assert.equal(dependencySteps.length, 1, `${context} must retain its exact dependency-install step exactly once`)
  assert.equal(dependencySteps[0]?.if, undefined, `${context} dependency install must not be conditional`)
  const dependencyInvocations = steps.reduce((count, step) => count + ((step.run ?? '').match(/\bnpm\b(?:(?![;&|]).)*\s(?:ci|install)\b/g) ?? []).length, 0)
  assert.equal(dependencyInvocations, 1, `${context} must invoke dependency installation exactly once`)
  const npmSteps = steps.flatMap((step, index) => /\bnpm(?:\s|$)/v.test(step.run ?? '') ? [index] : [])
  assert.ok(npmSteps.length > 0, `${context} must execute npm commands under isolated public configuration`)
  for (const stepIndex of npmSteps) {
    assert.ok(setupIndex < stepIndex, `${context}:step${stepIndex} npm invocation must follow configuration setup`)
  }

  const cleanupSteps = steps.filter(step => step.name?.toLowerCase().includes('public npm configuration') && step.run?.includes('cleanup'))
  assert.equal(cleanupSteps.length, 1, `${context} must clean up isolated public npm configuration exactly once`)
  const cleanupIndex = steps.indexOf(cleanupSteps[0])
  assert.ok(cleanupIndex > setupIndex, `${context} must clean up after npm configuration setup`)
  assert.equal(cleanupSteps[0]?.if, 'always()', `${context} npm cleanup must run after failure or cancellation`)
  assert.equal(cleanupSteps[0]?.run, cleanupCommand, `${context} must run the npm config cleanup command`)
  assert.equal(cleanupIndex, steps.length - 1, `${context} npm cleanup must be the final job step`)
}

function scan(repositoryRoot) {
  const workflows = new Map(workflowNames.map(name => [name, read(`.github/workflows/${name}`, repositoryRoot)]))
  const parsedWorkflows = new Map([...workflows].map(([name, workflow]) => [name, parseWorkflow(workflow, name)]))
  const ci = workflows.get('ci.yml')
  const acceptance = workflows.get('ci-acceptance.yml')
  const release = workflows.get('release.yml')
  const updateReleaseConfigs = workflows.get('update-release-configs.yml')
  const packedVerifier = read(packedVerifierPath, repositoryRoot)

  for (const [name, workflow] of workflows) {
    assert.doesNotMatch(workflow, /pull_request_target/, `${name}: privileged pull_request_target event is forbidden`)
    assert.doesNotMatch(workflow, /cache:\s*npm/, `${name}: npm cache is forbidden`)
    for (const match of workflow.matchAll(/^\s+uses:\s+([^\s]+)/gm)) {
      const reference = match[1]
      if (reference.startsWith('./')) continue
      const revision = reference.split('@')[1]
      assert.match(revision ?? '', /^[0-9a-f]{40}$/, `${name}: external action is not pinned to an immutable commit: ${reference}`)
    }

    for (const match of workflow.matchAll(/uses:\s+actions\/setup-node@[0-9a-f]{40}[\s\S]*?with:\n((?:\s{8,}.+\n?)*)/g)) {
      assert.match(match[1], /package-manager-cache:\s*false/, `${name}: setup-node must disable package-manager caching`)
    }
  }

  for (const [name, workflow] of parsedWorkflows) {
    const triggers = workflow[true] ?? workflow.on ?? {}
    assert.equal(Object.hasOwn(triggers, 'pull_request_target'), false, `${name}: pull_request_target event is forbidden`)
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (!/(?:secrets\.|private-key:)/.test(JSON.stringify(job))) continue
      assert.equal(job.environment, 'CredentialManagerInstall', `${name}:${jobName} secret-bearing job must use protected environment`)
      assert.ok(conjuncts(job.if ?? '').includes(normalizeExpression("vars.CREDENTIAL_MANAGER_INSTALL_ENABLED == 'true'")), `${name}:${jobName} secret-bearing job must require fail-closed enablement`)
    }
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const [stepIndex, step] of (job.steps ?? []).entries()) {
        if (!/\bnpm\b/i.test(step.run ?? '')) continue
        const effectiveEnvironment = {...(workflow.env ?? {}), ...(job.env ?? {}), ...(step.env ?? {})}
        for (const [key, value] of Object.entries(effectiveEnvironment)) {
          if (!/^(?:NODE_AUTH_TOKEN|NPM_TOKEN)$/i.test(key) && !/^npm_config_.*(?:auth|token|password|username)/i.test(key)) continue
          assert.equal(value, '', `${name}:${jobName}:step${stepIndex} must not pass ${key} to an npm operation`)
        }
      }
    }
  }

  for (const configuration of npmSetupJobs) {
    const [workflowName, jobName] = configuration
    const job = parsedWorkflows.get(workflowName)?.jobs?.[jobName]
    requireNpmConfigurationSequence(configuration, job)
  }

  assert.match(ci, /Run mandatory actionlint/)
  assert.match(ci, /sha256sum --check --strict/)
  assert.match(ci, /ACTIONLINT_VERSION='1\.7\.7'/)
  assert.match(ci, /ACTIONLINT_SHA256='023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757'/)
  assert.match(ci, /npm ci --ignore-scripts/)
  assert.match(ci, /npm rebuild/)
  assert.match(ci, /npm run lint/)
  assert.match(ci, /npm run test:coverage/)
  assert.match(ci, /npm run verify:packed-consumer/)
  assert.match(ci, /npm run verify:rollback/)
  assert.match(ci, /fetch-depth: 0/)
  assert.match(acceptance, /npm ci --ignore-scripts/)
  assert.match(acceptance, /npm rebuild/)
  assert.match(acceptance, /npm run test:ci:acceptance/)
  assert.match(acceptance, /dbus-run-session/)

  const publicNpmConfig = read('scripts/public-npm-config.mjs', repositoryRoot)
  assert.match(publicNpmConfig, /registry=https:\/\/registry\.npmjs\.org\/\\n'/, 'shared npm config must use public registry without auth')
  assert.match(publicNpmConfig, /preparePublicNpmConfig/)
  assert.match(publicNpmConfig, /NPM_CONFIG_GLOBALCONFIG/)
  assert.match(publicNpmConfig, /NPM_CONFIG_CACHE/)
  assert.match(publicNpmConfig, /NPM_CONFIG_LOGS_DIR/)
  assert.match(publicNpmConfig, /NPM_CONFIG_REGISTRY/)
  assert.match(publicNpmConfig, /NODE_AUTH_TOKEN: ''/)
  assert.match(publicNpmConfig, /NPM_TOKEN: ''/)
  assert.match(publicNpmConfig, /\['NODE_AUTH_TOKEN', ''\]/)
  assert.match(publicNpmConfig, /\['NPM_TOKEN', ''\]/)
  assert.match(publicNpmConfig, /Project \$\{presentConfig\} is forbidden/)
  assert.match(publicNpmConfig, /exportedEnvironment\.set\(name, ''\)/, 'ambient npm config overrides must be explicitly cleared')
  assert.match(publicNpmConfig, /if \(normalizedName\.startsWith\('npm_config_'\)\) \{\s*exportedEnvironment\.set\(name, ''\)/, 'public npm setup must overwrite arbitrary inherited npm settings rather than keeping their values')
  assert.match(publicNpmConfig, /createPublicNpmEnvironment/)
  assert.doesNotMatch(publicNpmConfig, /readFileSync\([^\n]*\.npmrc|readFile\([^\n]*\.npmrc/, 'public npm setup must not read credentials from a local npm config')
  assert.match(packedVerifier, /await writePublicNpmConfig\(target\)/)
  assert.match(packedVerifier, /Actual mutation output:\\n\$\{redact\(output\)\}/)
  assert.match(packedVerifier, /createPublicNpmEnvironment/)
  assert.match(packedVerifier, /assertAnonymousNpmEnvironment/)
  assert.match(packedVerifier, /\^npm_config_.*\(\?:auth\|token\|password\|username\)/, 'packed verifier must reject ambient npm auth-related configuration')
  assert.doesNotMatch(packedVerifier, /_authToken=|PACKED_VERIFY_NPM_SECRET_/, 'packed consumer resolver must not synthesize authenticated npm config')
  assert.match(read('.github/scripts/public-npm-install-canary.mjs', repositoryRoot), /\['ci', '--ignore-scripts'/)
  assert.match(read('.github/scripts/public-npm-install-canary.mjs', repositoryRoot), /empty-cache npm ci/)
  assert.match(ci, /node \.github\/scripts\/public-npm-install-canary\.mjs/)
  const rollbackVerifier = read(rollbackVerifierPath, repositoryRoot)
  assert.match(rollbackVerifier, /createPublicNpmEnvironment/)
  assert.match(rollbackVerifier, /anonymous npm ci --ignore-scripts/)
  assert.match(rollbackVerifier, /assert\.equal\(environment\.NODE_AUTH_TOKEN, ''\)/)
  assert.match(rollbackVerifier, /confinedSecrets/)
  const rollbackProduction = rollbackVerifier.split('async function selfTestAnonymousNpmFailure()')[0]
  for (const name of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_READ_TOKEN']) {
    assert.equal(rollbackProduction.includes(['process', 'env', name].join('.')), false, `rollback verifier must not read ${name} from the ambient environment`)
  }
  assert.doesNotMatch(rollbackVerifier, /node_modules\s*\).*copy|copyTree\(|treeFingerprint\(/)

  const packageManifest = JSON.parse(read('package.json', repositoryRoot))
  const credentialManager = packageManifest.dependencies?.['@heroku/heroku-credential-manager']
  assert.equal(credentialManager, '0.1.0', 'runtime credential-manager dependency must remain pinned')
  const lockfile = JSON.parse(read('package-lock.json', repositoryRoot))
  assert.equal(lockfile.packages?.['node_modules/@heroku/heroku-credential-manager']?.version, credentialManager)
  assert.equal(
    lockfile.packages?.['node_modules/@heroku/heroku-credential-manager']?.resolved,
    'https://registry.npmjs.org/@heroku/heroku-credential-manager/-/heroku-credential-manager-0.1.0.tgz',
  )

  const publish = release.split(/^ {2}publish:/m)[1] || ''
  const releaseWorkflow = parsedWorkflows.get('release.yml')
  const publishJob = releaseWorkflow.jobs?.publish
  const releaseBuild = release.match(/^ {2}build-package:\n(?:(?!^ {2}[A-Za-z0-9_-]+:\n)[\s\S])*/m)?.[0] || ''
  const releaseValidation = release.match(/^ {2}validate:\n(?:(?!^ {2}[A-Za-z0-9_-]+:\n)[\s\S])*/m)?.[0] || ''
  assert.doesNotMatch(publish, /npm ci|npm install(?! --global --ignore-scripts --no-audit --no-fund "npm@\$EXPECTED_NPM_VERSION")/, 'release publish job must not install source dependencies')
  const trustedNpmConfigCheckouts = publishJob?.steps?.filter(step => step.name === 'Check out trusted npm configuration helper') ?? []
  const publishCheckouts = publishJob?.steps?.filter(step => /^actions\/checkout@/i.test(step.uses ?? '')) ?? []
  assert.equal(trustedNpmConfigCheckouts.length, 1, 'publishing must check out only the trusted npm config helper')
  assert.deepEqual(publishCheckouts, trustedNpmConfigCheckouts, 'publishing must remain source-free apart from the trusted npm config helper')
  assert.match(trustedNpmConfigCheckouts[0]?.uses ?? '', /^actions\/checkout@[0-9a-f]{40}$/)
  assert.deepEqual(trustedNpmConfigCheckouts[0]?.with, {
    ref: `${githubExpressionStart} github.sha }}`,
    path: 'trusted-release-workflow',
    'persist-credentials': false,
    'sparse-checkout': 'scripts/public-npm-config.mjs',
    'sparse-checkout-cone-mode': false,
  }, 'publishing checkout must be immutable, sparse, and credential-free')
  assert.equal(publishJob?.environment, 'CredentialManagerInstall', 'publishing must retain protected environment approval')
  assertPermissions(publishJob?.permissions, {actions: 'read', contents: 'read', 'id-token': 'write'}, 'publish job')
  assert.ok(conjuncts(publishJob?.if ?? '').includes(normalizeExpression("vars.CREDENTIAL_MANAGER_INSTALL_ENABLED == 'true'")), 'publishing must remain fail-closed')
  const npmSetupIndex = publishJob?.steps?.findIndex(step => step.name === 'Prepare isolated public npm configuration') ?? -1
  const npmClientInstallIndex = publishJob?.steps?.findIndex(step => step.name === 'Install exact npm trusted-publishing client') ?? -1
  const cleanupIndex = publishJob?.steps?.findIndex(step => step.name === 'Remove isolated public npm configuration') ?? -1
  const npmInstallCommand = 'npm install --global --ignore-scripts --no-audit --no-fund "npm@$EXPECTED_NPM_VERSION"'
  const npmVersionCommand = 'test "$(npm --version)" = "$EXPECTED_NPM_VERSION"'
  assert.ok(npmSetupIndex >= 0 && npmSetupIndex < npmClientInstallIndex, 'isolated public npm configuration must be prepared before global npm install')
  assert.equal(publishJob.steps[npmSetupIndex]?.run, 'node trusted-release-workflow/scripts/public-npm-config.mjs setup')
  assert.ok(cleanupIndex > npmClientInstallIndex, 'isolated npm config cleanup must follow global npm install')
  assert.equal(publishJob.steps[cleanupIndex]?.if, 'always()', 'isolated npm state cleanup must run after success, failure, and cancellation')
  assert.equal(publishJob.steps[cleanupIndex]?.run, 'node trusted-release-workflow/scripts/public-npm-config.mjs cleanup')
  assert.equal(cleanupIndex, publishJob.steps.length - 1, 'isolated npm state cleanup must remain the final publish step')
  assert.equal(publishJob.steps[npmClientInstallIndex]?.run, npmInstallCommand)
  assert.deepEqual(publishJob.steps[npmClientInstallIndex]?.env, {EXPECTED_NPM_VERSION: '11.6.2'})
  assert.equal(publishJob.steps[npmClientInstallIndex]?.if, undefined)
  assert.equal(publishJob.steps.reduce((count, step) => count + ((step.run ?? '').split(npmInstallCommand).length - 1), 0), 1)
  const npmVersionChecks = publishJob.steps.filter(step => step.name === 'Verify exact npm trusted-publishing client version')
  assert.equal(npmVersionChecks.length, 1, 'publish job must verify npm client version exactly once')
  assert.equal(npmVersionChecks[0]?.run, npmVersionCommand)
  assert.deepEqual(npmVersionChecks[0]?.env, {EXPECTED_NPM_VERSION: '11.6.2'})
  assert.equal(npmVersionChecks[0]?.if, undefined, 'npm client version check must not be conditional')
  assert.equal(publishJob.steps.reduce((count, step) => count + ((step.run ?? '').split(npmVersionCommand).length - 1), 0), 1)
  assert.equal(publishJob.steps.reduce((count, step) => count + ((step.run ?? '').match(/\bnpm\s+--version\b/g) ?? []).length, 0), 1, 'publish job must inspect npm client version exactly once')
  assert.ok(publishJob.steps.indexOf(npmVersionChecks[0]) > npmClientInstallIndex, 'npm client version check must follow its install')
  assert.doesNotMatch(publish, /NPM_READ_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN|read-token:/, 'publish bootstrap must not reintroduce npm read auth')
  const publishStep = publishJob?.steps?.find(step => step.name === 'Verify and publish tarball')
  assert.ok(publishStep, 'publish job must verify and publish the release artifact')
  const publishCommands = publishStep.run.match(/^\s*npm publish .*$/gm) ?? []
  assert.deepEqual(publishCommands.map(command => command.trim()), [
    'npm publish "$ARTIFACT" --ignore-scripts --dry-run --tag "$NPM_TAG"',
    'npm publish "$ARTIFACT" --ignore-scripts --tag "$NPM_TAG"',
  ], 'dry-run and real publish commands must remain distinct branches')
  assert.match(publishStep.run, /if \[ "\$DRY_RUN" = 'true' \]; then\s+npm publish "\$ARTIFACT" --ignore-scripts --dry-run --tag "\$NPM_TAG"\s+else\s+npm publish "\$ARTIFACT" --ignore-scripts --tag "\$NPM_TAG"\s+fi/, 'dry-run must never fall through to real publish')
  assert.match(publish, /npm publish "\$ARTIFACT" --ignore-scripts --tag "\$NPM_TAG"/)
  assert.match(publish, /EXPECTED_NPM_VERSION: 11\.6\.2/)
  assert.match(publish, /test "\$\(npm --version\)" = "\$EXPECTED_NPM_VERSION"/)
  assert.match(release, /echo 'npm_tag=latest'/)
  assert.match(release, /echo 'npm_tag=beta'/)
  assert.match(release, /test "\$PR_HEAD_REPO" = "\$REPOSITORY"/)
  assert.match(release, /test "\$PR_HEAD_BRANCH" = "\$PR_BRANCH"/)
  assert.match(release, /test "\$PR_BASE_BRANCH" = "\$TARGET_BRANCH"/)
  assert.match(release, /test "\$\(git rev-parse HEAD\)" = "\$CANDIDATE_SHA"/)
  assert.match(release, /test "\$\(shasum -a 256 "\$ARTIFACT" \| cut -d ' ' -f 1\)" = "\$TARBALL_SHA256"/)
  assert.match(release, /TARBALL_SHA256/)
  assert.match(release, /SHA256SUMS/)
  assert.match(release, /npm run verify:packed-consumer/)
  assert.match(release, /npm run verify:rollback/)
  assert.match(releaseValidation, /Prepare anonymous npm configuration/)
  assert.match(releaseBuild, /Prepare anonymous npm configuration/)
  assert.match(releaseBuild, /fetch-depth: 0/)
  assert.match(releaseBuild, /persist-credentials: false/)
  for (const [name, job] of [['validate', releaseValidation], ['build-package', releaseBuild]]) {
    assert.match(job, /environment: CredentialManagerInstall/, `${name} must retain protected environment approval`)
    assert.match(job, /vars\.CREDENTIAL_MANAGER_INSTALL_ENABLED == 'true'/, `${name} must remain fail-closed`)
  }

  assert.match(release, /repositories: heroku-cli-command/)
  assert.match(release, /permission-contents: write/)
  assert.match(release, /permission-pull-requests: write/)
  assert.ok(release.includes(`token: ${githubAppToken}`))
  assert.match(updateReleaseConfigs, /repositories: npm-release-workflows/)
  assert.match(updateReleaseConfigs, /permission-contents: read/)
  assert.match(updateReleaseConfigs, /permission-contents: write/)
  assert.match(updateReleaseConfigs, /permission-pull-requests: write/)

  const completion = parsedWorkflows.get('release-on-push.yml')
  const releaseJob = completion.jobs?.['create-release']
  const releaseSteps = releaseJob?.steps
  const appSteps = releaseSteps?.filter(step => step.name === 'Generate release GitHub App token') ?? []
  const completionSteps = releaseSteps?.filter(step => step.name === 'Create GitHub release metadata') ?? []
  const releaseActions = Object.entries(completion.jobs ?? {}).flatMap(([jobName, job]) =>
    (job.steps ?? []).filter(step => /^googleapis\/release-please-action@/i.test(step.uses ?? '')).map(step => [jobName, step]))
  const appStep = appSteps[0]
  const completionStep = completionSteps[0]
  assertPermissions(completion.permissions, {contents: 'read'}, 'release completion workflow')
  assertPermissions(releaseJob?.permissions, {contents: 'write'}, 'release completion job')
  assert.equal(appSteps.length, 1)
  assert.equal(completionSteps.length, 1)
  assert.match(appStep?.uses ?? '', /^actions\/create-github-app-token@[0-9a-f]{40}$/)
  assert.equal(appStep?.with?.repositories, 'heroku-cli-command')
  assert.equal(appStep?.with?.['permission-contents'], 'write')
  assert.equal(appStep?.with?.['permission-pull-requests'], 'write')
  assert.equal(releaseActions.length, 1)
  assert.equal(releaseActions[0][0], 'create-release')
  assert.equal(releaseActions[0][1], completionStep)
  assert.match(completionStep?.uses ?? '', /^googleapis\/release-please-action@[0-9a-f]{40}$/)
  assert.equal(completionStep?.with?.token, githubAppToken)
  assert.equal(completionStep?.with?.['skip-github-pull-request'], true)
  assert.equal(completion[true]?.push?.branches?.join(','), 'main,beta', 'release completion push trigger must be limited to main and beta')
  assert.equal(releaseJob.environment, 'CredentialManagerInstall', 'release completion must require protected environment approval')
  requireJobGuards(releaseJob, 'release-on-push.yml', 'create-release', 'push')

  for (const jobName of ['validate', 'release-please-pr', 'build-package', 'publish']) {
    const job = releaseWorkflow.jobs?.[jobName]
    assert.ok(job, `release.yml must retain ${jobName} job`)
    assert.equal(job.environment, 'CredentialManagerInstall', `release.yml:${jobName} must require protected environment approval`)
    requireJobGuards(job, 'release.yml', jobName, 'workflow_dispatch')
  }
  assertPermissions(releaseWorkflow.permissions, {contents: 'read'}, 'release workflow')
  assertPermissions(releaseWorkflow.jobs?.['release-please-pr']?.permissions, {contents: 'write', 'pull-requests': 'write'}, 'release-please-pr job')
  assertPermissions(releaseWorkflow.jobs?.['build-package']?.permissions, {contents: 'read'}, 'build-package job')

  return workflows.size
}

const validCases = [
  ['unrelated README text', base => writeFileSync(join(base, 'README.md'), 'workflow trust fixture\n')],
]

function removeJobStep(workflow, jobName, stepName) {
  const lines = workflow.split('\n')
  const jobIndex = lines.indexOf(`  ${jobName}:`)
  if (jobIndex < 0) return workflow
  let jobEnd = lines.findIndex((line, index) => index > jobIndex && /^  [A-Za-z0-9_-]+:$/.test(line))
  if (jobEnd < 0) jobEnd = lines.length
  const stepIndex = lines.findIndex((line, index) => index > jobIndex && index < jobEnd && line === `      - name: ${stepName}`)
  if (stepIndex < 0) return workflow
  let stepEnd = lines.findIndex((line, index) => index > stepIndex && index < jobEnd && /^      - name:/.test(line))
  if (stepEnd < 0) stepEnd = jobEnd
  lines.splice(stepIndex, stepEnd - stepIndex)
  return lines.join('\n')
}

function moveJobStepAfter(workflow, jobName, stepName, afterStepName) {
  const lines = workflow.split('\n')
  const jobIndex = lines.indexOf(`  ${jobName}:`)
  if (jobIndex === -1) return workflow
  let jobEnd = lines.findIndex((line, index) => index > jobIndex && /^ {2}[\w\-]+:$/v.test(line))
  if (jobEnd < 0) jobEnd = lines.length
  const stepStart = lines.findIndex((line, index) => index > jobIndex && index < jobEnd && line === `      - name: ${stepName}`)
  if (stepStart === -1) return workflow
  let stepEnd = lines.findIndex((line, index) => index > stepStart && index < jobEnd && line.startsWith('      - name:'))
  if (stepEnd < 0) stepEnd = jobEnd
  const movedStep = lines.splice(stepStart, stepEnd - stepStart)
  jobEnd -= movedStep.length
  const afterIndex = lines.findIndex((line, index) => index > jobIndex && index < jobEnd && line === `      - name: ${afterStepName}`)
  if (afterIndex < 0) return workflow
  let afterEnd = lines.findIndex((line, index) => index > afterIndex && index < jobEnd && /^      - name:/.test(line))
  if (afterEnd < 0) afterEnd = jobEnd
  lines.splice(afterEnd, 0, ...movedStep)
  return lines.join('\n')
}

function insertJobStepBefore(workflow, jobName, stepName, insertedStep) {
  const lines = workflow.split('\n')
  const jobIndex = lines.indexOf(`  ${jobName}:`)
  if (jobIndex < 0) return workflow
  let jobEnd = lines.findIndex((line, index) => index > jobIndex && /^ {2}[\w\-]+:$/v.test(line))
  if (jobEnd < 0) jobEnd = lines.length
  const stepIndex = lines.findIndex((line, index) => index > jobIndex && index < jobEnd && line === `      - name: ${stepName}`)
  if (stepIndex < 0) return workflow
  lines.splice(stepIndex, 0, ...insertedStep.split('\n'))
  return lines.join('\n')
}

const mutationCases = [
  ['pull_request_target', '.github/workflows/ci.yml', text => `${text}\n# pull_request_target\n`],
  ['mutable action reference', '.github/workflows/ci.yml', text => text.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@main')],
  ['npm cache', '.github/workflows/ci.yml', text => `${text}\n# cache: npm\n`],
  ['missing fresh CI install', '.github/workflows/ci.yml', text => text.replaceAll('run: npm ci --ignore-scripts', 'run: npm install')],
  ['missing anonymous npm setup', '.github/workflows/ci.yml', text => text.replace('run: node scripts/public-npm-config.mjs', 'run: true')],
  ['lint npm setup removed', '.github/workflows/ci.yml', text => removeJobStep(text, 'lint', 'Prepare anonymous npm configuration')],
  ['test npm setup removed', '.github/workflows/ci.yml', text => removeJobStep(text, 'test', 'Prepare anonymous npm configuration')],
  ['verifiers npm setup removed', '.github/workflows/ci.yml', text => removeJobStep(text, 'verifiers', 'Prepare anonymous npm configuration')],
  ['acceptance npm setup removed', '.github/workflows/ci-acceptance.yml', text => removeJobStep(text, 'acceptance', 'Prepare anonymous npm configuration')],
  ['validate npm setup removed', '.github/workflows/release.yml', text => removeJobStep(text, 'validate', 'Prepare anonymous npm configuration')],
  ['build-package npm setup removed', '.github/workflows/release.yml', text => removeJobStep(text, 'build-package', 'Prepare anonymous npm configuration')],
  ['lint npm cleanup removed', '.github/workflows/ci.yml', text => removeJobStep(text, 'lint', 'Remove isolated public npm configuration')],
  ['test npm cleanup removed', '.github/workflows/ci.yml', text => removeJobStep(text, 'test', 'Remove isolated public npm configuration')],
  ['verifiers npm cleanup removed', '.github/workflows/ci.yml', text => removeJobStep(text, 'verifiers', 'Remove isolated public npm configuration')],
  ['acceptance npm cleanup removed', '.github/workflows/ci-acceptance.yml', text => removeJobStep(text, 'acceptance', 'Remove isolated public npm configuration')],
  ['validate npm cleanup removed', '.github/workflows/release.yml', text => removeJobStep(text, 'validate', 'Remove isolated public npm configuration')],
  ['build-package npm cleanup removed', '.github/workflows/release.yml', text => removeJobStep(text, 'build-package', 'Remove isolated public npm configuration')],
  ['lint npm setup moved after install', '.github/workflows/ci.yml', text => moveJobStepAfter(text, 'lint', 'Prepare anonymous npm configuration', 'Install dependencies')],
  ['test npm setup moved after install', '.github/workflows/ci.yml', text => moveJobStepAfter(text, 'test', 'Prepare anonymous npm configuration', 'Install dependencies')],
  ['verifiers npm setup moved after install', '.github/workflows/ci.yml', text => moveJobStepAfter(text, 'verifiers', 'Prepare anonymous npm configuration', 'Install dependencies')],
  ['acceptance npm setup moved after install', '.github/workflows/ci-acceptance.yml', text => moveJobStepAfter(text, 'acceptance', 'Prepare anonymous npm configuration', 'Install dependencies')],
  ['validate npm setup moved after install', '.github/workflows/release.yml', text => moveJobStepAfter(text, 'validate', 'Prepare anonymous npm configuration', 'Install dependencies')],
  ['build-package npm setup moved after install', '.github/workflows/release.yml', text => moveJobStepAfter(text, 'build-package', 'Prepare anonymous npm configuration', 'Install dependencies')],
  ['duplicate lint npm setup', '.github/workflows/ci.yml', text => insertJobStepBefore(
    text,
    'lint',
    'Install dependencies',
    '      - name: Duplicate anonymous npm configuration\n        run: node scripts/public-npm-config.mjs',
  )],
  ['npm setup helper invoked with extra shell command', '.github/workflows/ci.yml', text => insertJobStepBefore(
    text,
    'lint',
    'Install dependencies',
    '      - name: Extra npm setup invocation\n        run: node scripts/public-npm-config.mjs && true',
  )],
  ['npm setup helper invoked with OR shell suffix', '.github/workflows/ci.yml', text => insertJobStepBefore(
    text,
    'lint',
    'Install dependencies',
    '      - name: Extra npm setup invocation\n        run: node scripts/public-npm-config.mjs || true',
  )],
  ['npm setup helper invoked in conditional shell block', '.github/workflows/ci.yml', text => insertJobStepBefore(
    text,
    'lint',
    'Install dependencies',
    '      - name: Extra npm setup invocation\n        run: |\n          if true; then\n            node scripts/public-npm-config.mjs\n          fi',
  )],
  ['acceptance dependency install made conditional', '.github/workflows/ci-acceptance.yml', text => text.replace(
    '      - name: Install dependencies\n        run: npm ci --ignore-scripts',
    '      - name: Install dependencies\n        if: false\n        run: npm ci --ignore-scripts',
  )],
  ['npm install inserted before setup', '.github/workflows/ci.yml', text => insertJobStepBefore(
    text,
    'lint',
    'Prepare anonymous npm configuration',
    '      - name: Premature npm install\n        run: npm install',
  )],
  ['dependency install replaced with echo', '.github/workflows/ci-acceptance.yml', text => text.replace('run: npm ci --ignore-scripts', 'run: echo "npm ci --ignore-scripts skipped"')],
  ['dependency install changed to dry-run', '.github/workflows/ci-acceptance.yml', text => text.replace('run: npm ci --ignore-scripts', 'run: npm ci --ignore-scripts --dry-run')],
  ['dependency install hidden in conditional shell block', '.github/workflows/ci-acceptance.yml', text => text.replace(
    'run: npm ci --ignore-scripts',
    'run: |\n          if false; then\n            npm ci --ignore-scripts\n          fi',
  )],
  ['conditional dependency install added beside canonical step', '.github/workflows/ci-acceptance.yml', text => insertJobStepBefore(
    text,
    'acceptance',
    'Rebuild dependencies',
    '      - name: Conditional duplicate dependency install\n        run: |\n          if false; then\n            npm ci --ignore-scripts\n          fi',
  )],
  ['conditional install with altered args added beside canonical step', '.github/workflows/ci-acceptance.yml', text => insertJobStepBefore(
    text,
    'acceptance',
    'Rebuild dependencies',
    '      - name: Conditional alternate dependency install\n        if: runner.os == \'Linux\'\n        run: npm ci --ignore-scripts --registry=https://registry.invalid/',
  )],
  ['npm option-prefixed install added beside canonical step', '.github/workflows/ci-acceptance.yml', text => insertJobStepBefore(
    text,
    'acceptance',
    'Rebuild dependencies',
    '      - name: Alternate dependency install\n        run: npm --prefix ./other ci --ignore-scripts',
  )],
  ['npm version check replaced with echo', '.github/workflows/release.yml', text => text.replace(
    'run: test "$(npm --version)" = "$EXPECTED_NPM_VERSION"',
    'run: echo \'test "$(npm --version)" = "$EXPECTED_NPM_VERSION"\'',
  )],
  ['npm version check made conditional', '.github/workflows/release.yml', text => text.replace(
    '      - name: Verify exact npm trusted-publishing client version\n        env:',
    '      - name: Verify exact npm trusted-publishing client version\n        if: false\n        env:',
  )],
  ['duplicate npm version check added under another name', '.github/workflows/release.yml', text => insertJobStepBefore(
    text,
    'publish',
    'Verify and publish tarball',
    '      - name: Additional npm version check\n        env:\n          EXPECTED_NPM_VERSION: 11.6.2\n        run: test "$(npm --version)" = "$EXPECTED_NPM_VERSION"',
  )],
  ['npm version check added under another name', '.github/workflows/release.yml', text => insertJobStepBefore(
    text,
    'publish',
    'Verify and publish tarball',
    '      - name: Additional npm version check\n        run: npm --version',
  )],
  ['npm version check moved before install', '.github/workflows/release.yml', text => moveJobStepAfter(
    text,
    'publish',
    'Verify exact npm trusted-publishing client version',
    'Prepare isolated public npm configuration',
  )],
  ['missing package verifier', '.github/workflows/ci.yml', text => text.replace('run: npm run verify:packed-consumer', 'run: echo skipped')],
  ['missing rollback verifier', '.github/workflows/release.yml', text => text.replace('npm run verify:rollback', 'echo skipped')],
  ['public npm registry changed to private mirror', 'scripts/public-npm-config.mjs', text => text.replaceAll('registry.npmjs.org', 'registry.invalid')],
  ['ambient npm config survives public setup', 'scripts/public-npm-config.mjs', text => text.replace("exportedEnvironment.set(name, '')", 'exportedEnvironment.set(name, environment[name])')],
  ['ambient npm token survives public setup', 'scripts/public-npm-config.mjs', text => text.replace("['NODE_AUTH_TOKEN', '']", 'unused-token')],
  ['release candidate environment guard removed', '.github/workflows/release.yml', text => text.replace("vars.CREDENTIAL_MANAGER_INSTALL_ENABLED == 'true'", 'true')],
  ['release candidate repository guard changed', '.github/workflows/release.yml', text => text.replaceAll("github.repository == 'heroku/heroku-cli-command'", "github.repository == 'attacker/repository'")],
  ['release candidate ref guard expanded', '.github/workflows/release.yml', text => text.replaceAll("github.ref == 'refs/heads/main' || github.ref == 'refs/heads/beta'", "github.ref == 'refs/heads/main' || github.ref == 'refs/heads/v14.0.0'")],
  ['release completion enablement guard removed', '.github/workflows/release-on-push.yml', text => text.replace("vars.CREDENTIAL_MANAGER_INSTALL_ENABLED == 'true' &&\n      github.event_name == 'push'", "true &&\n      github.event_name == 'push'")],
  ['release completion repository guard removed', '.github/workflows/release-on-push.yml', text => text.replaceAll("github.repository == 'heroku/heroku-cli-command' &&\n      vars.CREDENTIAL_MANAGER_INSTALL_ENABLED", "github.repository == 'attacker/repository' &&\n      vars.CREDENTIAL_MANAGER_INSTALL_ENABLED")],
  ['release completion event guard removed', '.github/workflows/release-on-push.yml', text => text.replace("github.event_name == 'push'", "github.event_name == 'workflow_dispatch'")],
  ['release completion guarded ref expanded', '.github/workflows/release-on-push.yml', text => text.replace("github.ref == 'refs/heads/main' || github.ref == 'refs/heads/beta'", "github.ref == 'refs/heads/main' || github.ref == 'refs/heads/v14.0.0'")],
  ['release completion trigger expanded', '.github/workflows/release-on-push.yml', text => text.replace('branches: [main, beta]', 'branches: [main, beta, v14.0.0]')],
  ['release completion protected environment removed', '.github/workflows/release-on-push.yml', text => text.replace('    environment: CredentialManagerInstall\n', '')],
  ['release workflow broadens default permissions', '.github/workflows/release.yml', text => text.replace('permissions:\n  contents: read', 'permissions: write-all')],
  ['release publish dry-run condition inverted', '.github/workflows/release.yml', text => text.replace("if [ \"$DRY_RUN\" = 'true' ]; then", "if [ \"$DRY_RUN\" = 'false' ]; then")],
  ['publish npm setup removed', '.github/workflows/release.yml', text => text.replace('run: node trusted-release-workflow/scripts/public-npm-config.mjs setup', 'run: true')],
  ['publish npm setup step removed', '.github/workflows/release.yml', text => removeJobStep(text, 'publish', 'Prepare isolated public npm configuration')],
  ['publish npm setup moved after global install', '.github/workflows/release.yml', text => {
    const setup = /      - name: Prepare isolated public npm configuration\n        run: node trusted-release-workflow\/scripts\/public-npm-config\.mjs setup\n/.exec(text)?.[0]
    if (!setup) return text
    return text.replace(setup, '').replace('      - name: Verify and publish tarball\n', `${setup}      - name: Verify and publish tarball\n`)
  }],
  ['publish npm cleanup conditionalized', '.github/workflows/release.yml', text => text.replace('        if: always()\n        run: node trusted-release-workflow/scripts/public-npm-config.mjs cleanup', '        if: success()\n        run: node trusted-release-workflow/scripts/public-npm-config.mjs cleanup')],
  ['publish npm cleanup command bypassed', '.github/workflows/release.yml', text => text.replace('run: node trusted-release-workflow/scripts/public-npm-config.mjs cleanup', 'run: true')],
  ['publish npm cleanup removed', '.github/workflows/release.yml', text => text.replace('      - name: Remove isolated public npm configuration\n        if: always()\n        run: node trusted-release-workflow/scripts/public-npm-config.mjs cleanup\n', '')],
  ['release publish paths merged', '.github/workflows/release.yml', text => text.replace("          else\n            npm publish \"$ARTIFACT\" --ignore-scripts --tag \"$NPM_TAG\"\n          fi", "          fi\n          npm publish \"$ARTIFACT\" --ignore-scripts --tag \"$NPM_TAG\"")],
  ['release OIDC permission removed', '.github/workflows/release.yml', text => text.replace('      id-token: write\n', '')],
  ['release protected environment removed', '.github/workflows/release.yml', text => text.replace('    environment: CredentialManagerInstall\n', '')],
  ['release completion writes pull requests', '.github/workflows/release-on-push.yml', text => text.replace('      contents: write\n', '      contents: write\n      pull-requests: write\n')],
  ['release completion PR mutation enabled', '.github/workflows/release-on-push.yml', text => text.replace('skip-github-pull-request: true', 'skip-github-pull-request: false')],
  ['release completion uses default token', '.github/workflows/release-on-push.yml', text => {
    const defaultToken = `${githubExpressionStart} github.token }}`
    return text.replace(`token: ${githubAppToken}`, `token: ${defaultToken}`)
  }],
  ['release App token repository scope removed', '.github/workflows/release-on-push.yml', text => text.replace('repositories: heroku-cli-command', 'skip-token-revoke: false')],
  ['release artifact digest assertion removed', '.github/workflows/release.yml', text => text.replace('test "$(shasum -a 256 "$ARTIFACT" | cut -d \' \' -f 1)" = "$TARBALL_SHA256"', 'echo "$TARBALL_SHA256"')],
  ['release candidate repository check removed', '.github/workflows/release.yml', text => text.replace('test "$PR_HEAD_REPO" = "$REPOSITORY"', 'echo "$PR_HEAD_REPO"')],
  ['read-token restored', '.github/workflows/ci.yml', text => text.replace('      - name: Run packed consumer verification\n', '      - name: Run packed consumer verification\n        env:\n          read-token: \\${{ secrets.PRIVATE_NPM_TOKEN }}\n')],
  ['private token restored', '.github/workflows/ci.yml', text => text.replace('      - name: Run packed consumer verification\n', '      - name: Run packed consumer verification\n        env:\n          NODE_AUTH_TOKEN: \\${{ secrets.NPM_READ_TOKEN_HEROKU_CREDENTIAL_MANAGER }}\n')],
  ['npm install receives auth token', '.github/workflows/release.yml', text => text.replace('  validate:\n', "  validate:\n    env:\n      NODE_AUTH_TOKEN: \\${{ secrets.PRIVATE_NPM_TOKEN }}\n")],
  ['private token restored to public npm config', 'scripts/public-npm-config.mjs', text => {
    const tokenVariable = `${String.fromCodePoint(36)}{TOKEN}`
    return text.replace(
      String.raw`export const publicNpmConfig = 'registry=https://registry.npmjs.org/\n'`,
      `export const publicNpmConfig = 'registry=https://registry.npmjs.org/\\n//registry.npmjs.org/:_authToken=\\${tokenVariable}\\n'`,
    )
  }],
  ['packed verifier accepts auth tokens', packedVerifierPath, text => text.replace('if (/^npm_config_/i.test(key) && /(?:auth|token|password|username)/i.test(key)) {', 'if (false) {')],
  ['rollback verifier accepts auth tokens', rollbackVerifierPath, text => text.replace("assert.equal(environment.NODE_AUTH_TOKEN, '')", "assert.equal(environment.NODE_AUTH_TOKEN, 'token')")],
  ['rollback verifier authenticates npm install', rollbackVerifierPath, text => text.replace("assert.equal(environment.NODE_AUTH_TOKEN, '')", "assert.equal(environment.NODE_AUTH_TOKEN, 'token')")],
  ['OIDC permission removed', '.github/workflows/release.yml', text => text.replace('      id-token: write\n', '')],
  ['release environment removed', '.github/workflows/release.yml', text => text.replace('    environment: CredentialManagerInstall\n', '')],
  ['npm dry-run removed', '.github/workflows/release.yml', text => text.replace('--dry-run --tag', '--tag')],
]

const count = scan(root)
for (const [description, mutate] of validCases) {
  const fixture = mkdtempSync(join(tmpdir(), 'workflow-trust-valid-'))
  try {
    for (const relativePath of ['.github', 'scripts', 'test']) {
      copyTree(join(root, relativePath), join(fixture, relativePath))
    }

    for (const relativePath of ['package.json', 'package-lock.json', 'README.md']) {
      copyTree(join(root, relativePath), join(fixture, relativePath))
    }

    mutate(fixture)
    scan(fixture)
  } finally {
    rmSync(fixture, {force: true, recursive: true})
  }

  if (!description) throw new Error('valid workflow trust fixture must be named')
}

for (const [description, file, mutate] of mutationCases) {
  const fixture = mkdtempSync(join(tmpdir(), 'workflow-trust-mutation-'))
  try {
    for (const relativePath of ['.github', 'scripts']) {
      copyTree(join(root, relativePath), join(fixture, relativePath))
    }

    for (const relativePath of ['package.json', 'package-lock.json']) {
      copyTree(join(root, relativePath), join(fixture, relativePath))
    }

    const target = join(fixture, file)
    const original = readFileSync(target, 'utf8')
    const mutated = mutate(original)
    assert.notEqual(mutated, original, `${description} mutation did not change the fixture`)
    writeFileSync(target, mutated)
    assert.throws(() => scan(fixture), undefined, `${description} mutation should be rejected`)
  } finally {
    rmSync(fixture, {force: true, recursive: true})
  }
}

console.log(`workflow trust scan passed (${count} workflows; ${validCases.length} valid variants; ${mutationCases.length} rejected mutations)`)
