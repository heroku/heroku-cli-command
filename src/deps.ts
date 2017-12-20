// remote
import CLI = require('cli-ux')
import HTTP = require('http-call')

// local
import mutex = require('./mutex')
import yubikey = require('./yubikey')
import apiClient = require('./api_client')
import file = require('./file')
import git = require('./git')

import flags = require('./flags')

export const deps = {
  // remote
  get cli(): typeof CLI.default {
    return fetch('cli-ux').default
  },
  get HTTP(): typeof HTTP {
    return fetch('http-call')
  },

  // local
  get Mutex(): typeof mutex.Mutex {
    return fetch('./mutex').Mutex
  },
  get yubikey(): typeof yubikey.yubikey {
    return fetch('./yubikey').yubikey
  },
  get APIClient(): typeof apiClient.APIClient {
    return fetch('./api_client').APIClient
  },
  get file(): typeof file {
    return fetch('./file')
  },
  get flags(): typeof flags {
    return fetch('./flags')
  },
  get Git(): typeof git.Git {
    return fetch('./git').Git
  },
}

const cache: any = {}

function fetch(s: string) {
  if (!cache[s]) {
    cache[s] = require(s)
  }
  return cache[s]
}

export default deps
