import debug from 'debug'
import inquirer from 'inquirer'

const credDebug = debug('heroku-credential-manager')

/**
 * Prompts the user to select an account when multiple accounts are available.
 * @param accounts - Array of account names
 * @returns Promise that resolves with the selected account name, or undefined
 */
export async function selectAccount(accounts: string[]): Promise<string | undefined> {
  if (accounts.length === 0) {
    return
  }

  if (accounts.length === 1) {
    return accounts[0]
  }

  try {
    const {account} = await inquirer.prompt([{
      choices: accounts,
      message: 'Select an account for authentication:',
      name: 'account',
      type: 'list',
    }])

    return account
  } catch {
    credDebug('Failed to select an account')
  }
}
