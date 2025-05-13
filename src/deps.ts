// remote
import apiClient = require('./api-client')
import file = require('./file')
import flags = require('./flags')
import git = require('./git')
import mutex = require('./mutex')
import particleboardClient = require('./particleboard-client')
import yubikey = require('./yubikey')
import HTTP = require('@heroku/http-call')
import oclif = require('@oclif/core')
import netrc = require('netrc-parser')

const {ux} = oclif

export const deps = {
  get APIClient(): typeof apiClient.APIClient {
    return fetch('./api-client').APIClient
  },
  get Git(): typeof git.Git {
    return fetch('./git').Git
  },
  get HTTP(): typeof HTTP {
    return fetch('@heroku/http-call')
  },

  // local
  get Mutex(): typeof mutex.Mutex {
    return fetch('./mutex').Mutex
  },
  get ParticleboardClient(): typeof particleboardClient.ParticleboardClient {
    return fetch('./particleboard-client').ParticleboardClient
  },
  // remote
  get cli(): typeof ux {
    return fetch('@oclif/core').ux
  },
  get file(): typeof file {
    return fetch('./file')
  },
  get flags(): typeof flags {
    return fetch('./flags')
  },
  get netrc(): typeof netrc.default {
    return fetch('netrc-parser').default
  },
  get yubikey(): typeof yubikey.yubikey {
    return fetch('./yubikey').yubikey
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cache: Record<string, any> = {}

function fetch(s: string) {
  if (!cache[s]) {
    cache[s] = require(s)
  }

  return cache[s]
}

export default deps
