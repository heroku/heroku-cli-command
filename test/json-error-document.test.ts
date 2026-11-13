import {Errors} from '@oclif/core'
import {expect} from 'fancy-test'

import {HerokuAPIError} from '../src/api-client.js'
import {
  debugErrorText,
  MAX_CAUSE_DEPTH,
  MAX_DOCUMENT_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_SUGGESTIONS,
  redactSecrets,
  toErrorDocument,
} from '../src/error-document.js'

const LEGACY_TOKEN = '01234567-89ab-cdef-0123-456789abcdef'

function apiError(statusCode: number, body: Record<string, unknown>) {
  return new HerokuAPIError({body, statusCode} as never)
}

describe('toErrorDocument', () => {
  it('builds a document for a plain Error', () => {
    expect(toErrorDocument(new Error('boom'), {exitCode: 1})).to.deep.equal({exitCode: 1, message: 'boom', name: 'Error'})
  })

  it('keeps the code and suggestions of a CLIError', () => {
    const err = new Errors.CLIError('nope', {code: 'HEROKU_NONINTERACTIVE_LOGIN', suggestions: ['run heroku login']})
    expect(toErrorDocument(err, {exitCode: 2})).to.deep.equal({
      code: 'HEROKU_NONINTERACTIVE_LOGIN',
      exitCode: 2,
      message: 'nope',
      name: 'CLIError',
      suggestions: ['run heroku login'],
    })
  })

  it('flattens a 404 API error and never copies its body', () => {
    const err = apiError(404, {
      app: {id: 'a1', name: 'my-app'}, id: 'not_found', message: 'Couldn\'t find that app.', resource: 'app', url: 'https://devcenter.heroku.com/x',
    })
    const document = toErrorDocument(err, {exitCode: 1})
    expect(document).to.include({
      id: 'not_found', name: 'HerokuAPIError', resource: 'app', statusCode: 404, url: 'https://devcenter.heroku.com/x',
    })
    expect(document.message).to.contain('Couldn\'t find that app.')
    expect(document).to.not.have.any.keys('body', 'http', 'app')
  })

  it('flattens a 401 API error', () => {
    const document = toErrorDocument(apiError(401, {id: 'unauthorized', message: 'Invalid credentials provided.'}), {exitCode: 1})
    expect(document).to.include({id: 'unauthorized', statusCode: 401})
  })

  it('keeps the code of a network error', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND api.heroku.com'), {code: 'ENOTFOUND', hostname: 'api.heroku.com'})
    expect(toErrorDocument(err, {exitCode: 1})).to.deep.equal({
      code: 'ENOTFOUND', exitCode: 1, message: 'getaddrinfo ENOTFOUND api.heroku.com', name: 'Error',
    })
  })

  it('wraps a thrown non-Error', () => {
    expect(toErrorDocument('just a string', {exitCode: 1})).to.deep.equal({exitCode: 1, message: 'just a string', name: 'Error'})
  })

  it('uses the message of a thrown plain object, and never "[object Object]"', () => {
    expect(toErrorDocument({message: 'from an object'}, {exitCode: 1}).message).to.equal('from an object')
    expect(toErrorDocument({status: 'bad'}, {exitCode: 1}).message).to.equal('The command failed with a value that isn\'t an error.')
    expect(toErrorDocument(Object.create(null), {exitCode: 1}).message).to.equal('The command failed with a value that isn\'t an error.')
  })

  it('names the class of an error that does not set name', () => {
    class NonExistentFlagsError extends Error {}
    expect(toErrorDocument(new NonExistentFlagsError('x'), {exitCode: 2}).name).to.equal('NonExistentFlagsError')
  })

  it('keeps an explicit name over the class name', () => {
    const err = Object.assign(new Errors.CLIError('x'), {name: 'NotFoundError'})
    expect(toErrorDocument(err, {exitCode: 1}).name).to.equal('NotFoundError')
  })

  it('keeps the request ID and retryAfter of a heroku-fetch error', () => {
    const err = Object.assign(new Error('Rate limit exceeded'), {
      response: new Response(null, {headers: {'Request-Id': 'req-123'}, status: 429}),
      retryAfter: 30,
      statusCode: 429,
    })
    expect(toErrorDocument(err, {exitCode: 1})).to.include({requestId: 'req-123', retryAfter: 30, statusCode: 429})
  })

  it('keeps the request ID of an http-call error', () => {
    const err = Object.assign(new Error('HTTP Error 500'), {http: {headers: {'request-id': 'req-456'}, statusCode: 500}})
    expect(toErrorDocument(err, {exitCode: 1})).to.include({requestId: 'req-456', statusCode: 500})
  })

  it('drops a retryAfter that is not a finite number', () => {
    const err = Object.assign(new Error('slow down'), {retryAfter: NaN})
    expect(toErrorDocument(err, {exitCode: 1})).to.not.have.property('retryAfter')
  })

  it('includes the cause, without an exit code', () => {
    const err = new Error('outer', {cause: Object.assign(new TypeError('inner'), {code: 'E_INNER'})})
    expect(toErrorDocument(err, {exitCode: 1}).cause).to.deep.equal({code: 'E_INNER', message: 'inner', name: 'TypeError'})
  })

  it(`stops at ${MAX_CAUSE_DEPTH} causes`, () => {
    let err = new Error('level 5')
    for (let i = 4; i >= 0; i--) err = new Error(`level ${i}`, {cause: err})
    let depth = 0
    for (let document = toErrorDocument(err, {exitCode: 1}); document.cause; document = document.cause) depth++
    expect(depth).to.equal(MAX_CAUSE_DEPTH)
  })

  it('terminates on a cyclic cause', () => {
    const a = new Error('a')
    const b = new Error('b', {cause: a})
    Object.defineProperty(a, 'cause', {value: b})
    expect(toErrorDocument(a, {exitCode: 1})).to.deep.equal({
      cause: {message: 'b', name: 'Error'}, exitCode: 1, message: 'a', name: 'Error',
    })
  })

  it('ignores fields whose getters throw', () => {
    const err = new Error('boom')
    Object.defineProperty(err, 'code', {
      get() {
        throw new Error('getter')
      },
    })
    expect(toErrorDocument(err, {exitCode: 1})).to.deep.equal({exitCode: 1, message: 'boom', name: 'Error'})
  })

  it('strips ANSI codes', () => {
    expect(toErrorDocument(new Error('\u{1B}[31mred\u{1B}[39m'), {exitCode: 1}).message).to.equal('red')
  })

  it('caps the message and the number of suggestions', () => {
    const err = new Errors.CLIError('x'.repeat(MAX_MESSAGE_LENGTH * 2), {suggestions: Array.from({length: 10}, (_, i) => `s${i}`)})
    const document = toErrorDocument(err, {exitCode: 1})
    expect(document.message).to.have.length(MAX_MESSAGE_LENGTH)
    expect(document.message.endsWith('…')).to.equal(true)
    expect(document.suggestions).to.have.length(MAX_SUGGESTIONS)
  })

  it('keeps the serialized document under the size limit', () => {
    // Control characters are escaped as \uXXXX, six times their length.
    let err = new Errors.CLIError('\u{1}'.repeat(MAX_MESSAGE_LENGTH), {suggestions: Array.from({length: 5}, () => 'y'.repeat(2000))})
    for (let i = 0; i < 3; i++) err = new Errors.CLIError('\u{1}'.repeat(MAX_MESSAGE_LENGTH), {cause: err} as never)
    expect(JSON.stringify(toErrorDocument(err, {exitCode: 1})).length).to.be.at.most(MAX_DOCUMENT_LENGTH)
  })

  it('redacts secrets in every string field', () => {
    const err = new Errors.CLIError(`token ${LEGACY_TOKEN} rejected`, {code: LEGACY_TOKEN, suggestions: [`use ${LEGACY_TOKEN}`]})
    const json = JSON.stringify(toErrorDocument(err, {exitCode: 1, secrets: [LEGACY_TOKEN]}))
    expect(json).to.not.contain(LEGACY_TOKEN)
    expect(json).to.contain('[REDACTED]')
  })
})

describe('redactSecrets', () => {
  it('redacts exact values of 8 characters or more', () => {
    expect(redactSecrets(`a ${LEGACY_TOKEN} b`, [LEGACY_TOKEN])).to.equal('a [REDACTED] b')
    expect(redactSecrets('the app failed', ['app', undefined])).to.equal('the app failed')
  })

  it('redacts Heroku tokens, Authorization values and URL credentials', () => {
    expect(redactSecrets('HRKU-AAb_c-123 is bad')).to.equal('[REDACTED] is bad')
    expect(redactSecrets('Authorization: Bearer abc.def-123')).to.equal('Authorization: Bearer [REDACTED]')
    expect(redactSecrets('basic dXNlcjpwYXNz')).to.equal('basic [REDACTED]')
    expect(redactSecrets('postgres://user:p%40ss@host:5432/db')).to.equal('postgres://[REDACTED]@host:5432/db')
  })

  it('leaves URLs without credentials alone', () => {
    expect(redactSecrets('see https://devcenter.heroku.com/articles/x')).to.equal('see https://devcenter.heroku.com/articles/x')
  })
})

describe('debugErrorText', () => {
  it('includes the stack and redacts secrets', () => {
    const text = debugErrorText(Object.assign(new Error('boom'), {token: LEGACY_TOKEN}), [LEGACY_TOKEN])
    expect(text).to.contain('at ')
    expect(text).to.not.contain(LEGACY_TOKEN)
  })
})
