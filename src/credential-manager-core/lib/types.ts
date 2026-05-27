export type NetrcAuthEntry = {
  login: string
  password: string
}

export type KeychainAuthEntry = {
  account: string
  service: string
  token: string
}

export type AuthEntry = {
  account: string | undefined
  token: string | undefined
}
