declare module 'netrc-parser' {
  interface NetrcMachine {
    login?: string
    password?: string
    method?: string
    org?: string
  }

  interface NetrcTokens {
    host: string
    internalWhitespace?: string
  }

  interface Netrc {
    machines: { [key: string]: NetrcMachine }
    _tokens?: NetrcTokens[]
    load(): Promise<void>
    loadSync(): void
    save(): Promise<void>
  }

  const netrc: Netrc
  export default netrc
} 
