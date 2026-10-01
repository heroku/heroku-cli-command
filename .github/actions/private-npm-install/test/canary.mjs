import {spawnSync, execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const actionDirectory = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL('..', import.meta.url))
const token = `fake-private-token-${Date.now()}`

const runScenario = shouldFail => {
  const temp = mkdtempSync(join(tmpdir(), 'private-npm-canary-'))
  const output = join(temp, 'output')
  const environment = join(temp, 'environment')
  writeFileSync(output, '')
  writeFileSync(environment, '')

  const env = {
    ...process.env,
    GITHUB_ENV: environment,
    GITHUB_OUTPUT: output,
    JOB_NAME: shouldFail ? 'failure' : 'success',
    RUN_ATTEMPT: '1',
    RUN_ID: 'canary',
    RUNNER_TEMP: temp,
  }

  execFileSync(process.execPath, [join(actionDirectory, 'prepare.mjs')], {env, stdio: 'pipe'})
  const outputs = Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map(line => line.split(/=(.*)/s).slice(0, 2)),
  )
  const config = readFileSync(outputs.userconfig, 'utf8')

  if (config.includes(token) || !config.includes('${NODE_AUTH_TOKEN}')) {
    throw new Error('The npm config must contain only the literal token placeholder')
  }
  if (process.platform !== 'win32' && (statSync(outputs.root).mode & 0o777) !== 0o700) {
    throw new Error('The temporary npm directory must be owner-only')
  }
  if (process.platform !== 'win32' && (statSync(outputs.userconfig).mode & 0o777) !== 0o600) {
    throw new Error('The npm userconfig must be owner-only')
  }
  for (const path of [outputs.cache, outputs.logs, outputs.clean_root, outputs.clean_cache, outputs.clean_logs]) {
    if (process.platform !== 'win32' && (statSync(path).mode & 0o777) !== 0o700) {
      throw new Error(`The temporary npm directory must be owner-only: ${path}`)
    }
  }
  if (process.platform !== 'win32' && (statSync(outputs.clean_userconfig).mode & 0o777) !== 0o600) {
    throw new Error('The clean npm userconfig must be owner-only')
  }

  const install = spawnSync(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs');
       const config=fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, 'utf8');
       if (!config.includes('\${NODE_AUTH_TOKEN}') || config.includes(process.env.NODE_AUTH_TOKEN)) process.exit(23);
       fs.writeFileSync(process.env.NPM_CONFIG_LOGS_DIR + '/npm.log', 'install output without credentials\\n');
       process.stdout.write('simulated npm ci output without credentials\\n');
       process.exit(${shouldFail ? 42 : 0});`,
    ],
    {
      env: {
        ...env,
        NODE_AUTH_TOKEN: token,
        NPM_CONFIG_CACHE: outputs.cache,
        NPM_CONFIG_LOGS_DIR: outputs.logs,
        NPM_CONFIG_USERCONFIG: outputs.userconfig,
      },
      encoding: 'utf8',
    },
  )
  const installOutput = `${install.stdout || ''}${install.stderr || ''}`
  if (installOutput.includes(token)) throw new Error('The fake token appeared in install output')
  if (shouldFail ? install.status !== 42 : install.status !== 0) {
    throw new Error(`The simulated npm ci returned unexpected status ${install.status}`)
  }
  if (readFileSync(join(outputs.logs, 'npm.log'), 'utf8').includes(token)) {
    throw new Error('The fake token appeared in an npm log')
  }
  writeFileSync(output, `${readFileSync(output, 'utf8')}canary_status=${shouldFail ? 'failure' : 'success'}\n`)

  try {
    if (shouldFail && install.status !== 0) throw new Error('simulated npm ci failure')
  } catch {
    // The composite action's always() cleanup is modeled by the finally block.
  } finally {
    execFileSync(process.execPath, [join(actionDirectory, 'cleanup.mjs')], {
      env: {
        ...env,
        PRIVATE_NPM_ROOT: outputs.root,
        PRIVATE_NPM_USERCONFIG: outputs.userconfig,
        PRIVATE_NPM_CLEAN_ROOT: outputs.clean_root,
        PRIVATE_NPM_CLEAN_CACHE: outputs.clean_cache,
        PRIVATE_NPM_CLEAN_LOGS: outputs.clean_logs,
        PRIVATE_NPM_CLEAN_USERCONFIG: outputs.clean_userconfig,
      },
      stdio: 'pipe',
    })
  }

  const cleanEnvironment = readFileSync(environment, 'utf8')
  if (!cleanEnvironment.includes(`NPM_CONFIG_USERCONFIG=${outputs.clean_userconfig}`)) {
    throw new Error('Cleanup did not export the known-empty npm userconfig')
  }
  const cleanConfig = readFileSync(outputs.clean_userconfig, 'utf8')
  if (/_authToken|NODE_AUTH_TOKEN|fake-private-token/.test(cleanConfig)) {
    throw new Error('The clean npm userconfig contains authentication material')
  }
  const downstream = spawnSync(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs');
       if (process.env.NODE_AUTH_TOKEN) process.exit(31);
       const config=fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, 'utf8');
       if (/_authToken|NODE_AUTH_TOKEN|fake-private-token/.test(config)) process.exit(32);
       process.stdout.write('token-free rebuild and test simulation\\n');`,
    ],
    {
      env: {
        ...env,
        NODE_AUTH_TOKEN: '',
        NPM_CONFIG_CACHE: outputs.clean_cache,
        NPM_CONFIG_LOGS_DIR: outputs.clean_logs,
        NPM_CONFIG_USERCONFIG: outputs.clean_userconfig,
      },
      encoding: 'utf8',
    },
  )
  if (downstream.status !== 0 || `${downstream.stdout}${downstream.stderr}`.includes(token)) {
    throw new Error('The token-free downstream command canary failed')
  }

  execFileSync(process.execPath, [join(actionDirectory, 'finalize.mjs')], {
    env: {...env, PRIVATE_NPM_CLEAN_ROOT: outputs.clean_root},
    stdio: 'pipe',
  })

  const survivingText = [output, environment]
    .map(file => readFileSync(file, 'utf8'))
    .join('\n')
  if (survivingText.includes(token)) throw new Error('The fake token survived in action output')
  if (readdirSync(temp).some(name => name.startsWith('private-npm-'))) {
    throw new Error('The temporary npm directory survived cleanup')
  }
}

runScenario(false)
runScenario(true)
console.log('private npm fake-token canaries passed (success and simulated failure)')
