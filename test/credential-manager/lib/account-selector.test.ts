import {expect} from 'chai'
import inquirer from 'inquirer'
import sinon from 'sinon'

import {selectAccount} from '../../../src/credential-manager-core/lib/account-selector.js'

describe('selectAccount', function () {
  let promptStub: sinon.SinonStub

  beforeEach(function () {
    promptStub = sinon.stub(inquirer, 'prompt')
  })

  afterEach(function () {
    sinon.restore()
  })

  it('should return undefined without prompting when no accounts are provided', async function () {
    const result = await selectAccount([])

    expect(result).to.be.undefined
    expect(promptStub.called).to.be.false
  })

  it('should return the account without prompting when only one account is provided', async function () {
    const result = await selectAccount(['user@example.com'])

    expect(result).to.equal('user@example.com')
    expect(promptStub.called).to.be.false
  })

  it('should prompt user to select an account when multiple accounts are provided', async function () {
    promptStub.resolves({account: 'user2@example.com'})

    const result = await selectAccount(['user1@example.com', 'user2@example.com', 'user3@example.com'])

    expect(result).to.equal('user2@example.com')
    expect(promptStub.calledOnce).to.be.true
    expect(promptStub.args[0][0]).to.deep.equal([{
      choices: ['user1@example.com', 'user2@example.com', 'user3@example.com'],
      message: 'Select an account for authentication:',
      name: 'account',
      type: 'list',
    }])
  })

  it('should return undefined when prompt fails', async function () {
    promptStub.rejects(new Error('User cancelled'))

    const result = await selectAccount(['user1@example.com', 'user2@example.com'])

    expect(result).to.be.undefined
    expect(promptStub.calledOnce).to.be.true
  })
})
