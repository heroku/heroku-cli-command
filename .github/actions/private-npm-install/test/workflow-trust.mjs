import {cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const oldReadTokenReference = ['NPM', 'TOKEN_HEROKU_CREDENTIAL_MANAGER'].join('_')
const countExactLines = (text, expected) => text.split('\n').filter(line => line.trim() === expected).length

const scan = repositoryRoot => {
  const workflowDirectory = resolve(repositoryRoot, '.github/workflows')
  const workflows = readdirSync(workflowDirectory)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map(name => [name, readFileSync(resolve(workflowDirectory, name), 'utf8')])

  const forbidden = [
    ['pull request target', /pull_request_target/],
    ['npm cache', /cache:\s*npm/],
    ['mutable shared workflow ref', /heroku\/npm-release-workflows@main/],
    ['npm ci outside the reviewed action', /npm ci/],
  ]

  for (const [name, workflow] of workflows) {
    for (const [description, pattern] of forbidden) {
      if (pattern.test(workflow)) throw new Error(`${name}: found forbidden ${description}`)
    }
  }

  const readTokenReference = ['secrets', 'NPM_READ_TOKEN_HEROKU_CREDENTIAL_MANAGER'].join('.')
  for (const [name, workflow] of workflows) {
    if (workflow.includes(oldReadTokenReference)) throw new Error(`${name}: deprecated npm read secret name remains`)
  }
  for (const [name, workflow] of workflows) {
    for (const line of workflow.split('\n').filter(line => line.includes(readTokenReference))) {
      if (!line.trim().startsWith('read-token:')) {
        throw new Error(`${name}: private read token is used outside the trusted action invocation`)
      }
    }
  }

  const action = readFileSync(resolve(repositoryRoot, '.github/actions/private-npm-install/action.yml'), 'utf8')

  const actionHeadEquality = /^\s*test "\$\(git -C "\$GITHUB_ACTION_PATH" rev-parse HEAD\)" = "\$EXPECTED_ACTION_SHA"\s*$/m
  if (!actionHeadEquality.test(action)) {
    throw new Error('private npm action does not require its exact HEAD to equal EXPECTED_ACTION_SHA')
  }

  const maskIndex = action.indexOf('echo "::add-mask::$READ_TOKEN"')
  const tokenUseIndex = action.indexOf('NODE_AUTH_TOKEN: ${{ inputs.read-token }}')
  if (maskIndex < 0 || tokenUseIndex < 0 || maskIndex > tokenUseIndex) {
    throw new Error('private npm action does not mask the read token before token-bearing use')
  }
  if (/set -[^\n]*x/.test(action.slice(Math.max(0, maskIndex - 200), maskIndex + 100))) {
    throw new Error('private npm action enables xtrace while masking the read token')
  }

  for (const [name, workflow] of [...workflows, ['private-npm-install/action.yml', action]]) {
    for (const line of workflow.split('\n').filter(line => /^\s+uses:\s+[^.]/.test(line))) {
      const reference = line.trim().split(/\s+/)[1]
      const revision = reference.split('@')[1]
      if (!revision || !/^[0-9a-f]{40}$/.test(revision)) {
        throw new Error(`${name}: external action is not pinned to an immutable commit: ${reference}`)
      }
    }
  }

  for (const [name, workflow] of [...workflows, ['private-npm-install/action.yml', action]]) {
    for (const setupNode of workflow.matchAll(/uses:\s+actions\/setup-node@[0-9a-f]{40}[\s\S]*?with:\n((?:\s{8,}.+\n?)*)/g)) {
      if (!/package-manager-cache:\s*false/.test(setupNode[1])) {
        throw new Error(`${name}: setup-node invocation does not explicitly disable package-manager caching`)
      }
    }
  }

  if (!/NPM_CONFIG_USERCONFIG:\s*\$\{\{ steps\.npm-paths\.outputs\.clean_userconfig \}\}/.test(action)) {
    throw new Error('private npm action does not use its known-empty config for rebuild')
  }
  if (/NPM_CONFIG_USERCONFIG:\s*''/.test(action)) {
    throw new Error('private npm action clears userconfig to an uncontrolled default')
  }
  const posixCleanup = action.split('    - name: Verify POSIX credential cleanup')[1]?.split('    - name: Verify Windows credential cleanup')[0] || ''
  if (!/PRIVATE_NPM_CLEAN_USERCONFIG:\s*\$\{\{ steps\.npm-paths\.outputs\.clean_userconfig \}\}/.test(posixCleanup)) {
    throw new Error('private npm action does not expose the clean userconfig to POSIX cleanup verification')
  }
  for (const name of ['ROOT', 'CACHE', 'LOGS', 'USERCONFIG']) {
    if (!action.includes(`PRIVATE_NPM_${name}:`)) throw new Error(`private npm action omits ${name} ACL coverage`)
  }

  const release = readFileSync(resolve(workflowDirectory, 'release.yml'), 'utf8')
  const publish = release.split(/^  publish:/m)[1] || ''
  if (/NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_USERCONFIG|npm ci/.test(publish)) {
    throw new Error('release.yml: publish job contains private-read auth or a source dependency install')
  }
  if (/actions\/checkout@|read-token:|npm ci|npm install(?! --global --ignore-scripts --no-audit --no-fund "npm@\$EXPECTED_NPM_VERSION")/.test(publish)) {
    throw new Error('release.yml: publish job checks out source or installs source dependencies')
  }
  for (const requirement of [
    "EXPECTED_NPM_VERSION: 11.6.2",
    'npm install --global --ignore-scripts --no-audit --no-fund "npm@$EXPECTED_NPM_VERSION"',
    'test "$(npm --version)" = "$EXPECTED_NPM_VERSION"',
    'const minimum = [11, 5, 1]',
  ]) {
    if (!publish.includes(requirement)) throw new Error(`release.yml: missing trusted-publishing npm assertion: ${requirement}`)
  }
  if (!/test -n "\$PR_JSON"/.test(release) || /startsWith\("release-please--branches--"\)|EXPECTED_PR_BRANCH|expected_pr_branch/.test(release)) {
    throw new Error('release.yml: candidate selection permits a broad or stale release PR fallback')
  }
  if (/v14\.0\.0/.test(release)) throw new Error('release.yml: integration branch is present in a publishing workflow')
  for (const mapping of [
    'github.ref == \'refs/heads/main\' || github.ref == \'refs/heads/beta\'',
    'main)',
    "echo 'npm_tag=latest'",
    'beta)',
    "echo 'npm_tag=beta'",
  ]) {
    if (!release.includes(mapping)) throw new Error(`release.yml: publishing channel mapping missing: ${mapping}`)
  }
  if (/v14\.0\.0[\s\S]{0,300}npm_tag=latest|npm_tag=latest[\s\S]{0,300}v14\.0\.0/.test(release)) {
    throw new Error('release.yml: integration branch maps to latest')
  }
  for (const assertion of [
    'test "$PR_HEAD_REPO" = "$REPOSITORY"',
    'test -n "$PR_BRANCH"',
    'test "$PR_HEAD_BRANCH" = "$PR_BRANCH"',
    'test "$PR_BASE_BRANCH" = "$TARGET_BRANCH"',
    'test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"',
    'test "$PACKAGE_NAME" = \'@heroku-cli/command\'',
    'test "$PACKAGE_VERSION" = "$MANIFEST_VERSION"',
    'test "$(cat "$RUNNER_TEMP/release-artifact/SOURCE_SHA")" = "$CANDIDATE_SHA"',
    'test "$(cat "$RUNNER_TEMP/release-artifact/NPM_TAG")" = "$NPM_TAG"',
    'test "$PACKED_NAME" = "$EXPECTED_PACKAGE_NAME"',
    'test "$PACKED_VERSION" = "$(cat "$RUNNER_TEMP/release-artifact/PACKAGE_VERSION")"',
    'test "$(shasum -a 256 "$ARTIFACT" | cut -d \' \' -f 1)" = "$TARBALL_SHA256"',
  ]) {
    if (!release.includes(assertion)) throw new Error(`release.yml: missing candidate assertion: ${assertion}`)
  }
  if (!release.includes("if [ \"$DRY_RUN\" = 'true' ]") || !release.includes('npm publish "$ARTIFACT" --ignore-scripts --dry-run')) {
    throw new Error('release.yml: dry-run path is not explicitly non-publishing')
  }
  if (!/if \[ "\$DRY_RUN" = 'true' \]; then\n\s+npm publish "\$ARTIFACT" --ignore-scripts --dry-run --tag "\$NPM_TAG"\n\s+else\n\s+npm publish "\$ARTIFACT" --ignore-scripts --tag "\$NPM_TAG"\n\s+fi/.test(release)) {
    throw new Error('release.yml: dry-run can reach the real publish command')
  }

  const ci = readFileSync(resolve(workflowDirectory, 'ci.yml'), 'utf8')
  for (const requirement of [
    "ACTIONLINT_VERSION='1.7.7'",
    "ACTIONLINT_SHA256='023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757'",
    'sha256sum --check --strict',
    'Run mandatory actionlint',
    '"$RUNNER_TEMP/actionlint-bin/actionlint"',
  ]) {
    if (!ci.includes(requirement)) throw new Error(`ci.yml: mandatory pinned actionlint invariant missing: ${requirement}`)
  }
  if (/if command -v actionlint|actionlint is not installed/.test(ci)) {
    throw new Error('ci.yml: actionlint is optional')
  }

  for (const [name, workflow] of [['ci.yml', ci], ['release.yml', release]]) {
    const trustedActionCheckouts = workflow.match(/- name: Check out trusted action definition[\s\S]*?(?=\n\s{6}- name:|\n\s{2}[A-Za-z0-9_-]+:|$)/g) || []
    for (const checkout of trustedActionCheckouts) {
      if (!checkout.includes('ref: ${{ github.sha }}')) {
        throw new Error(`${name}: trusted action checkout is not bound to immutable github.sha`)
      }
    }
  }

  for (const [name, workflow] of workflows) {
    const expectedInvocationCount = privateActionWorkflowCounts.get(`workflows/${name}`) ?? 0
    const expectedNodeVersions = privateActionNodeVersions.get(`workflows/${name}`) ?? []
    const privateActionInvocations = workflow.match(/uses:\s+\.\/trusted-action\/\.github\/actions\/private-npm-install\n\s+with:\n(?:\s{10}.+\n?)*/g) || []
    if (privateActionInvocations.length !== expectedInvocationCount) {
      throw new Error(`${name}: private action invocation count was ${privateActionInvocations.length}, expected ${expectedInvocationCount}`)
    }
    for (const [index, invocation] of privateActionInvocations.entries()) {
      for (const input of [
        'read-token: ${{ secrets.NPM_READ_TOKEN_HEROKU_CREDENTIAL_MANAGER }}',
        'expected-action-sha: ${{ github.sha }}',
        'working-directory: candidate',
        `node-version: ${expectedNodeVersions[index]}`,
      ]) {
        if (countExactLines(invocation, input) !== 1) {
          throw new Error(`${name}: private action invocation ${index + 1} requires exact input: ${input}`)
        }
      }
    }
    const expectedActionInputs = workflow.match(/expected-action-sha:/g) || []
    if (expectedActionInputs.length !== privateActionInvocations.length) {
      throw new Error(`${name}: private action invocation/input count mismatch`)
    }
  }
  const acceptance = readFileSync(resolve(workflowDirectory, 'ci-acceptance.yml'), 'utf8')
  if (!/- name: Check out trusted action definition[\s\S]*?ref: \$\{\{ github\.sha \}\}/.test(acceptance)) {
    throw new Error('ci-acceptance.yml: trusted action checkout is not bound to immutable github.sha')
  }

  const packageManifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
  for (const script of ['verify:packed-consumer', 'verify:rollback', 'verify:rollback:guards', 'verify:rollback:cleanup', 'verify:trusted']) {
    if (!packageManifest.scripts?.[script]) throw new Error(`package.json: missing verifier script ${script}`)
  }
  for (const requirement of ['npm run verify:packed-consumer', 'npm run verify:rollback']) {
    if (countExactLines(ci, requirement) !== 1) throw new Error(`ci.yml: trusted verifier gate must be one exact line: ${requirement}`)
    if (countExactLines(release, requirement) !== 1) throw new Error(`release.yml: release candidate verifier gate must be one exact line: ${requirement}`)
  }
  for (const assertion of [
    'test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"',
    "test \"$PACKAGE_NAME\" = '@heroku-cli/command'",
    'test "$PACKAGE_VERSION" = "$MANIFEST_VERSION"',
  ]) {
    if (countExactLines(release, assertion) !== 1) throw new Error(`release.yml: candidate assertion must be one exact line: ${assertion}`)
  }
  if (countExactLines(acceptance, 'run: npm run test:ci:acceptance') !== 1 || countExactLines(acceptance, 'npm run test:ci:acceptance') !== 1) {
    throw new Error('ci-acceptance.yml: macOS/Windows and nested Linux acceptance commands must be exact lines')
  }
  if (/packed_baseline_sha:|PACKED_CONSUMER_BASELINE_SHA:/.test(release) || /PACKED_CONSUMER_BASELINE_SHA:/.test(ci)) {
    throw new Error('packed baseline must come from reviewed repository metadata, not workflow inputs or variables')
  }

  const packedVerifier = readFileSync(resolve(repositoryRoot, 'scripts/verify-packed-consumer.mjs'), 'utf8')
  const baselineMetadata = readFileSync(resolve(repositoryRoot, '.github/packed-consumer-baseline'), 'utf8').trim()
  if (!/^[0-9a-f]{40}$/.test(baselineMetadata)) throw new Error('authoritative packed baseline metadata is not exactly 40-hex')
  const baselineEquality = /^\s*check\(requestedBaselineSha === authoritativeBaselineSha, `requested baseline \$\{requestedBaselineSha\} does not equal authoritative baseline \$\{authoritativeBaselineSha\}`\) \/\/ MUTATION_ANCHOR_BASELINE_EQUALITY\s*$/m
  if (!baselineEquality.test(packedVerifier)) throw new Error('packed verifier does not enforce exact authoritative baseline override equality')
  const baselineExistence = /^\s*await run\('git', \['cat-file', '-e', `\$\{authoritativeBaselineSha\}\^\{commit\}`\], \{env: workspace\.baseEnvironment, label: `authoritative baseline commit \$\{authoritativeBaselineSha\}`\}\) \/\/ MUTATION_ANCHOR_BASELINE_EXISTENCE\s*$/m
  if (!baselineExistence.test(packedVerifier)) throw new Error('packed verifier does not prove the authoritative baseline commit exists')
  for (const requirement of ['baseline-sha', 'PACKED_CONSUMER_BASELINE_SHA', 'packed-consumer-baseline', 'heroku-credential-manager[^/]*\\.tgz', 'MUTATION_ANCHOR_PACKED_LOGIN_HTTP']) {
    if (!packedVerifier.includes(requirement)) throw new Error(`packed verifier invariant missing: ${requirement}`)
  }
  const rollbackVerifier = readFileSync(resolve(repositoryRoot, 'scripts/verify-credential-manager-rollback.mjs'), 'utf8')
  if (!rollbackVerifier.includes('NODE_AUTH_TOKEN: npmAuthToken') || !rollbackVerifier.includes('_authToken=\\${NODE_AUTH_TOKEN}')) {
    throw new Error('rollback verifier does not keep the token placeholder and confine the resolved token to npm ci')
  }

  const releaseOnPush = readFileSync(resolve(workflowDirectory, 'release-on-push.yml'), 'utf8')
  if (!releaseOnPush.includes('skip-github-pull-request: true') || /pull-requests:\s*write/.test(releaseOnPush)) {
    throw new Error('release-on-push.yml: release completion can mutate release PRs')
  }
  if (/v14\.0\.0/.test(releaseOnPush) || !releaseOnPush.includes('branches: [main, beta]')) {
    throw new Error('release-on-push.yml: completion channels must be exactly main and beta')
  }

  const updateReleaseConfigs = readFileSync(resolve(workflowDirectory, 'update-release-configs.yml'), 'utf8')
  if (/v14\.0\.0/.test(updateReleaseConfigs)) {
    throw new Error('update-release-configs.yml: integration branch cannot update publication metadata')
  }
  if (!updateReleaseConfigs.includes("github.ref == 'refs/heads/main' || github.ref == 'refs/heads/beta'")) {
    throw new Error('update-release-configs.yml: expected main/beta branch guard is missing')
  }

  for (const [name, workflow] of workflows) {
    const tokenSteps = workflow.match(/uses:\s+actions\/create-github-app-token@[0-9a-f]{40}[\s\S]*?(?=\n\s{6}- name:|\n\s{2}[A-Za-z0-9_-]+:|$)/g) || []
    for (const step of tokenSteps) {
      if (!/repositories:\s*[A-Za-z0-9_-]+/.test(step) || !/permission-contents:\s*(read|write)/.test(step)) {
        throw new Error(`${name}: GitHub App token is not repository- and permission-scoped`)
      }
    }
  }

  for (const name of ['ci.yml', 'ci-acceptance.yml', 'release.yml']) {
    const workflow = readFileSync(resolve(workflowDirectory, name), 'utf8')
    const jobs = workflow.match(/^  [A-Za-z0-9_-]+:\n(?:(?!^  [A-Za-z0-9_-]+:\n)[\s\S])*/gm) || []
    for (const job of jobs.filter(value => value.includes(readTokenReference))) {
      if (!job.includes('environment: CredentialManagerInstall')) {
        throw new Error(`${name}: read-token job is missing the protected environment`)
      }
    }
  }

  for (const name of ['release-on-push.yml', 'update-release-configs.yml', 'pr-title-check.yml']) {
    const workflow = readFileSync(resolve(workflowDirectory, name), 'utf8')
    if (/NPM_READ_TOKEN_HEROKU_CREDENTIAL_MANAGER|NODE_AUTH_TOKEN|npm ci/.test(workflow)) {
      throw new Error(`${name}: metadata-only workflow contains private-read auth or npm ci`)
    }
  }

  for (const [name, workflow] of workflows) {
    const jobs = workflow.match(/^  [A-Za-z0-9_-]+:\n(?:(?!^  [A-Za-z0-9_-]+:\n)[\s\S])*/gm) || []
    for (const job of jobs.filter(value => /secrets\.|private-key:|read-token:/.test(value))) {
      if (!job.includes('environment: CredentialManagerInstall')) {
        throw new Error(`${name}: secret-bearing job is missing the protected environment`)
      }
      if (!job.includes("vars.CREDENTIAL_MANAGER_INSTALL_ENABLED == 'true'")) {
        throw new Error(`${name}: secret-bearing job is missing the fail-closed enablement guard`)
      }
    }
  }

  return workflows.length
}

const privateActionWorkflowCounts = new Map([
  ['workflows/ci.yml', 3],
  ['workflows/ci-acceptance.yml', 1],
  ['workflows/release.yml', 2],
])
const privateActionNodeVersions = new Map([
  ['workflows/ci.yml', ['22.x', '${{ matrix.node-version }}', '22.x']],
  ['workflows/ci-acceptance.yml', ['${{ matrix.node-version }}']],
  ['workflows/release.yml', ['22.x', '22.x']],
])
const privateActionPath = './trusted-action/.github/actions/private-npm-install'
const replaceOccurrence = (text, target, replacement, occurrence) => {
  let index = -1
  for (let count = 0; count <= occurrence; count += 1) index = text.indexOf(target, index + 1)
  return index < 0 ? text : `${text.slice(0, index)}${replacement}${text.slice(index + target.length)}`
}
const privateInputMutations = [...privateActionWorkflowCounts].flatMap(([file]) => [
  ['read-token', '${{ secrets.NPM_READ_TOKEN_HEROKU_CREDENTIAL_MANAGER }}', '${{ secrets.OTHER_TOKEN }}'],
  ['working-directory', 'candidate', '.'],
  ['node-version', file === 'workflows/ci-acceptance.yml' ? '${{ matrix.node-version }}' : '22.x', ''],
].flatMap(([input, expected, replacement]) => [
  [`${file} private action ${input} substituted`, file, text => text.replace(`${input}: ${expected}`, `${input}: ${replacement}`)],
  [`${file} private action ${input} removed`, file, text => text.replace(`          ${input}: ${expected}\n`, '')],
]))
const privateActionMutationCases = [...privateActionWorkflowCounts].flatMap(([file]) => [
  [`${file} private action path changed`, file, text => text.replace(privateActionPath, './candidate')],
  [
    `${file} private action with block removed`,
    file,
    text => text.replace(/(uses:\s+\.\/trusted-action\/\.github\/actions\/private-npm-install)\n\s+with:\n(?:\s{10}.+\n?)*/, '$1\n'),
  ],
  [`${file} private action expected binding removed`, file, text => text.replace(/^\s+expected-action-sha: \$\{\{ github\.sha \}\}\n/m, '')],
  [
    `${file} unexpected private action invocation added`,
    file,
    text => `${text}\n  unexpected-private-install:\n    steps:\n      - uses: ${privateActionPath}\n        with:\n          read-token: \${{ secrets.NPM_READ_TOKEN_HEROKU_CREDENTIAL_MANAGER }}\n          expected-action-sha: \${{ github.sha }}\n          working-directory: candidate\n`,
  ],
])
const criticalLineMutations = [
  ['workflows/ci.yml', 'npm run verify:packed-consumer', 0],
  ['workflows/ci.yml', 'npm run verify:rollback', 0],
  ['workflows/release.yml', 'npm run verify:packed-consumer', 0],
  ['workflows/release.yml', 'npm run verify:rollback', 0],
  ['workflows/release.yml', 'test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"', 0],
  ['workflows/release.yml', "test \"$PACKAGE_NAME\" = '@heroku-cli/command'", 0],
  ['workflows/release.yml', 'test "$PACKAGE_VERSION" = "$MANIFEST_VERSION"', 0],
  ['workflows/ci-acceptance.yml', 'npm run test:ci:acceptance', 0],
  ['workflows/ci-acceptance.yml', 'npm run test:ci:acceptance', 1],
].flatMap(([file, line, occurrence]) => [
  ['|| true', ' || true'],
  ['; true', '; true'],
  ['catch/swallow', ' || echo swallowed'],
].map(([variant, suffix]) => [
  `${file} critical line ${line} occurrence ${occurrence + 1} ${variant}`,
  file,
  text => replaceOccurrence(text, line, `${line}${suffix}`, occurrence),
]))

const mutationCases = [
  ...privateActionMutationCases,
  ...privateInputMutations,
  ...criticalLineMutations,
  ['pull_request_target', 'workflows/ci.yml', text => `${text}\n# pull_request_target\n`],
  ['mutable action ref', 'workflows/ci.yml', text => text.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@main')],
  ['mutable trusted action checkout', 'workflows/ci.yml', text => text.replace('ref: ${{ github.sha }}\n          path: trusted-action', 'ref: ${{ github.ref }}\n          path: trusted-action')],
  ['npm cache', 'workflows/ci.yml', text => `${text}\n# cache: npm\n`],
  ['secret outside trusted action', 'workflows/ci.yml', text => `${text}\n# NODE_AUTH_TOKEN: \${{ secrets.NPM_READ_TOKEN_HEROKU_CREDENTIAL_MANAGER }}\n`],
  [
    'read token mask removed',
    'actions/private-npm-install/action.yml',
    text => text.replace('echo "::add-mask::$READ_TOKEN"', 'echo "token mask omitted"'),
  ],
  [
    'trusted action HEAD equality removed',
    'actions/private-npm-install/action.yml',
    text => text.replace('test "$(git -C "$GITHUB_ACTION_PATH" rev-parse HEAD)" = "$EXPECTED_ACTION_SHA"', 'git -C "$GITHUB_ACTION_PATH" rev-parse HEAD'),
  ],
  [
    'trusted action HEAD equality failure swallowed',
    'actions/private-npm-install/action.yml',
    text => text.replace('test "$(git -C "$GITHUB_ACTION_PATH" rev-parse HEAD)" = "$EXPECTED_ACTION_SHA"', 'test "$(git -C "$GITHUB_ACTION_PATH" rev-parse HEAD)" = "$EXPECTED_ACTION_SHA" || true'),
  ],
  [
    'CI expected action SHA changed',
    'workflows/ci.yml',
    text => text.replace('expected-action-sha: ${{ github.sha }}', 'expected-action-sha: ${{ github.ref }}'),
  ],
  [
    'release expected action SHA changed',
    'workflows/release.yml',
    text => text.replace('expected-action-sha: ${{ github.sha }}', 'expected-action-sha: ${{ needs.release-please-pr.outputs.candidate_sha }}'),
  ],
  [
    'broad stale release PR fallback',
    'workflows/release.yml',
    text => text.replace('test -n "$PR_JSON"', 'test -n "$PR_JSON"\n          # startsWith("release-please--branches--")'),
  ],
  [
    'uncontrolled rebuild npm config',
    'actions/private-npm-install/action.yml',
    text => text.replace(
      'NPM_CONFIG_USERCONFIG: ${{ steps.npm-paths.outputs.clean_userconfig }}',
      "NPM_CONFIG_USERCONFIG: ''",
    ),
  ],
  [
    'missing trusted-publishing npm assertion',
    'workflows/release.yml',
    text => text.replace('test "$(npm --version)" = "$EXPECTED_NPM_VERSION"', 'echo "$EXPECTED_NPM_VERSION"'),
  ],
  [
    'optional actionlint',
    'workflows/ci.yml',
    text => text.replace('- name: Run mandatory actionlint', '- name: Run actionlint when installed'),
  ],
  [
    'candidate repository assertion removed',
    'workflows/release.yml',
    text => text.replace('test "$PR_HEAD_REPO" = "$REPOSITORY"', 'echo "$PR_HEAD_REPO"'),
  ],
  [
    'returned release branch assertion removed',
    'workflows/release.yml',
    text => text.replace('test "$PR_HEAD_BRANCH" = "$PR_BRANCH"', 'echo "$PR_HEAD_BRANCH"'),
  ],
  [
    'candidate source assertion removed',
    'workflows/release.yml',
    text => text.replace('test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"', 'echo "$CANDIDATE_SHA"'),
  ],
  [
    'candidate version assertion removed',
    'workflows/release.yml',
    text => text.replace('test "$PACKAGE_VERSION" = "$MANIFEST_VERSION"', 'echo "$PACKAGE_VERSION"'),
  ],
  [
    'candidate tag assertion removed',
    'workflows/release.yml',
    text => text.replace('test "$(cat "$RUNNER_TEMP/release-artifact/NPM_TAG")" = "$NPM_TAG"', 'echo "$NPM_TAG"'),
  ],
  [
    'candidate digest assertion removed',
    'workflows/release.yml',
    text => text.replace('test "$(shasum -a 256 "$ARTIFACT" | cut -d \' \' -f 1)" = "$TARBALL_SHA256"', 'echo "$TARBALL_SHA256"'),
  ],
  [
    'release completion PR mutation enabled',
    'workflows/release-on-push.yml',
    text => text.replace('skip-github-pull-request: true', 'skip-github-pull-request: false'),
  ],
  [
    'setup-node cache control removed',
    'workflows/release.yml',
    text => text.replace('package-manager-cache: false', 'check-latest: false'),
  ],
  [
    'App token repository scope removed',
    'workflows/release-on-push.yml',
    text => text.replace('repositories: heroku-cli-command', 'skip-token-revoke: false'),
  ],
  [
    'dry-run reaches real publish',
    'workflows/release.yml',
    text => text.replace('npm publish "$ARTIFACT" --ignore-scripts --dry-run --tag "$NPM_TAG"', 'npm publish "$ARTIFACT" --ignore-scripts --tag "$NPM_TAG"'),
  ],
  [
    'deprecated read secret restored',
    'workflows/ci.yml',
    text => text.replace('NPM_READ_TOKEN_HEROKU_CREDENTIAL_MANAGER', oldReadTokenReference),
  ],
  [
    'v14 release enabled',
    'workflows/release.yml',
    text => text.replace("refs/heads/main", "refs/heads/v14.0.0"),
  ],
  [
    'v14 release completion enabled',
    'workflows/release-on-push.yml',
    text => text.replace('branches: [main, beta]', 'branches: [v14.0.0, beta]'),
  ],
  [
    'stable branch maps to beta tag',
    'workflows/release.yml',
    text => text.replace("echo 'npm_tag=latest'", "echo 'npm_tag=beta'"),
  ],
  [
    'beta branch maps to latest tag',
    'workflows/release.yml',
    text => {
      const first = text.indexOf("echo 'npm_tag=beta'")
      return first < 0 ? text : `${text.slice(0, first)}echo 'npm_tag=latest'${text.slice(first + "echo 'npm_tag=beta'".length)}`
    },
  ],
  [
    'packed tarball scan narrowed to one version',
    '../scripts/verify-packed-consumer.mjs',
    text => text.replace('heroku-credential-manager[^/]*\\.tgz', 'heroku-credential-manager-0\\.1\\.0\\.tgz'),
  ],
  [
    'packed LoginHttp scan removed',
    '../scripts/verify-packed-consumer.mjs',
    text => text.replace(/\s*check\(!\/\\bLoginHttp\\w\*\/\.test\(source\), `found removed LoginHttp\* symbol in packed file \$\{path\}`\) \/\/ MUTATION_ANCHOR_PACKED_LOGIN_HTTP/, ''),
  ],
  [
    'authoritative baseline equality bypassed',
    '../scripts/verify-packed-consumer.mjs',
    text => text.replace('check(requestedBaselineSha === authoritativeBaselineSha,', 'check(Boolean(requestedBaselineSha),'),
  ],
  [
    'authoritative baseline equality failure swallowed',
    '../scripts/verify-packed-consumer.mjs',
    text => text.replace(') // MUTATION_ANCHOR_BASELINE_EQUALITY', ') || true // MUTATION_ANCHOR_BASELINE_EQUALITY'),
  ],
  [
    'authoritative baseline commit existence removed',
    '../scripts/verify-packed-consumer.mjs',
    text => text.replace(/\s*await run\('git', \['cat-file', '-e', `\$\{authoritativeBaselineSha\}\^\{commit\}`\][^\n]*\n/, '\n'),
  ],
  [
    'authoritative baseline commit existence failure swallowed',
    '../scripts/verify-packed-consumer.mjs',
    text => text.replace(') // MUTATION_ANCHOR_BASELINE_EXISTENCE', ') || true // MUTATION_ANCHOR_BASELINE_EXISTENCE'),
  ],
  [
    'authoritative baseline commit existence rejection caught',
    '../scripts/verify-packed-consumer.mjs',
    text => text.replace(') // MUTATION_ANCHOR_BASELINE_EXISTENCE', ').catch(() => true) // MUTATION_ANCHOR_BASELINE_EXISTENCE'),
  ],
  [
    'rollback npmrc embeds resolved token',
    '../scripts/verify-credential-manager-rollback.mjs',
    text => text.replace("'//registry.npmjs.org/:_authToken=\\${NODE_AUTH_TOKEN}'", "'//registry.npmjs.org/:_authToken=' + npmAuthToken"),
  ],
  [
    'trusted packed verifier gate removed',
    'workflows/ci.yml',
    text => text.replace('npm run verify:packed-consumer', 'echo packed verifier omitted'),
  ],
]

const count = scan(root)
for (const [description, file, mutate] of mutationCases) {
  const fixture = mkdtempSync(join(tmpdir(), 'workflow-trust-mutation-'))
  try {
    cpSync(resolve(root, '.github'), resolve(fixture, '.github'), {recursive: true})
    cpSync(resolve(root, 'scripts'), resolve(fixture, 'scripts'), {recursive: true})
    cpSync(resolve(root, 'package.json'), resolve(fixture, 'package.json'))
    const target = resolve(fixture, '.github', file)
    const original = readFileSync(target, 'utf8')
    const mutated = mutate(original)
    if (mutated === original) throw new Error(`mutation did not change text: ${description}`)
    writeFileSync(target, mutated)
    let rejected = false
    try {
      scan(fixture)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(`mutation was not rejected: ${description}`)
  } finally {
    rmSync(fixture, {force: true, recursive: true})
  }
}

console.log(`workflow trust scan passed (${count} workflows; ${mutationCases.length} rejected mutations)`)
