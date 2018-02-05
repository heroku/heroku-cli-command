import {expect, fancy} from 'fancy-test'

import * as childProcess from 'child_process'

import {Git} from '../src/git'

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

  fancy
  .stub(childProcess, 'execSync', () => {
    const err: any = new Error('some other message')
    err.code = 'ENOTNOENT'
    throw err
  })
  .it('rethrows other git error', () => {
    const git = new Git()
    expect(() => {
      git.exec('version')
    }).to.throw('some other message')
  })
})
