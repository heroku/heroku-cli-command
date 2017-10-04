import apiClient = require('./api_client')
import mutex = require('./mutex')
import yubikey = require('./yubikey')

import cli = require('cli-ux')
import http = require('http-call')

export const deps = {
  // local
  get apiClient(): typeof apiClient {
    return fetch('./api_client')
  },
  get yubikey(): typeof yubikey.yubikey {
    return fetch('./yubikey').yubikey
  },
  get Mutex(): typeof mutex.Mutex {
    return fetch('./mutex').Mutex
  },

  // remote
  get cli(): typeof cli.default {
    return fetch('cli-ux').default
  },
  get HTTP(): typeof http.HTTP {
    return fetch('http-call').HTTP
  },
}

const cache: any = {}

function fetch(s: string) {
  if (!cache[s]) {
    cache[s] = require(s)
  }
  return cache[s]
}
