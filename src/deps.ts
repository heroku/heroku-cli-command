// This file isn't necessary and should be removed.
// I reorganized the code to make it easier to understand
// but it is entirely unnecessary to have a file like this.
// I'm leaving it here for now, but it should be removed
// in the future.
import oclif = require('@oclif/core')
import HTTP = require('@heroku/http-call')

import apiClient = require('./api-client')
import particleboardClient = require('./particleboard-client')
import file = require('./file')
import flags = require('./flags')
import git = require('./git')
import mutex = require('./mutex')
import yubikey = require('./yubikey')

const {ux} = oclif

export const deps = {
  cli: ux,
  HTTP,
  Mutex: mutex.Mutex,
  yubikey: yubikey.yubikey,
  APIClient: apiClient.APIClient,
  ParticleboardClient: particleboardClient.ParticleboardClient,
  file,
  flags,
  Git: git.Git,
}

export default deps
