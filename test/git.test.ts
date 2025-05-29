import {expect} from 'chai'
import childProcess from 'node:child_process'
import sinon from 'sinon'

import {Git} from '../src/git.js'

describe('git', () => {
  it('gets the remotes', () => {
    const git = new Git()
    git.exec = () => `origin\thttps://github.com/foo/bar  (fetch)
origin\thttps://github.com/foo/bar  (pull)
heroku\thttps://git.heroku.com/myapp.git  (fetch)
heroku\thttps://git.heroku.com/myapp.git  (pull)
`
    expect(git.remotes).to.deep.equal([
      {name: 'origin', url: 'https://github.com/foo/bar'},
      {name: 'heroku', url: 'https://git.heroku.com/myapp.git'},
    ])
  })

  it('rethrows other git error', () => {
    const stub = sinon.stub(childProcess, 'execSync').callsFake(() => {
      const err: any = new Error('some other message')
      err.code = 'SOME_OTHER_CODE'
      throw err
    })
    const git = new Git()
    expect(() => {
      git.exec('version')
    }).to.throw('some other message')
    stub.restore()
  })
})
