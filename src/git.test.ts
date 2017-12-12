import Git from './git'
import * as childProcess from 'child_process'

jest.mock('child_process')

test('gets the remotes', () => {
  const git = new Git()
  git.exec = jest.fn()
  ;(<any>git.exec).mockReturnValueOnce(`origin\thttps://github.com/foo/bar  (fetch)
origin\thttps://github.com/foo/bar  (pull)
heroku\thttps://git.heroku.com/myapp.git  (fetch)
heroku\thttps://git.heroku.com/myapp.git  (pull)
`)
  expect(git.remotes).toEqual([
    { name: 'origin', url: 'https://github.com/foo/bar' },
    { name: 'heroku', url: 'https://git.heroku.com/myapp.git' },
  ])
  expect(git.exec).toBeCalledWith('remote -v')
})

test('runs git', () => {
  const git = new Git()
  git.exec('version')
  expect(childProcess.execSync).toBeCalledWith('git version', {
    encoding: 'utf8',
    stdio: [null, 'pipe', null],
  })
})

test('traps git not found', () => {
  const err = new Error()
  ;(<any>err).code = 'ENOENT'
  ;(<any>childProcess.execSync).mockImplementationOnce(() => {
    throw err
  })

  const git = new Git()
  expect(() => {
    git.exec('version')
  }).toThrow('Git must be installed to use the Heroku CLI.  See instructions here: http://git-scm.com')
})

test('rethrows other git error', () => {
  const err = new Error('some other message')
  ;(<any>err).code = 'NOTENOENT'
  ;(<any>childProcess.execSync).mockImplementationOnce(() => {
    throw err
  })

  const git = new Git()
  expect(() => {
    git.exec('version')
  }).toThrow(err.message)
})
