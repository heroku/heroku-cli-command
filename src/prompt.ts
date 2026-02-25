/* eslint-disable complexity */
import {type Config, run} from '@oclif/core'
import inquirer from 'inquirer'

interface PromptOptions {
  argv: string[]
  commandId: string
  config: Config
}

// eslint-disable-next-line valid-jsdoc
/**
 * Interactively prompts the user for command arguments and flags,
 * then re-runs the command with the collected inputs.
 */
export async function promptAndRun(options: PromptOptions): Promise<void> {
  const {argv, commandId, config} = options

  const commandMeta = config.findCommand(commandId)
  if (!commandMeta) return

  // Prompt for args and flags
  const userInputByArg = new Map()
  const userInputByFlag = new Map()

  // Prompt for arguments
  for (const [argKey, argDef] of Object.entries(commandMeta.args)) {
    const {description, required} = argDef as any
    if (!description) continue

    // eslint-disable-next-line no-await-in-loop
    const {input} = await inquirer.prompt([{
      message: `${description} (${required ? 'required' : 'optional - press "Enter" to bypass'})`,
      name: 'input',
      type: 'input',
      validate(value: string) {
        if (!required || value.trim()) {
          return true
        }

        return `${description} is required`
      },
    }])

    if (input && input.trim()) {
      userInputByArg.set(argKey, input)
    }
  }

  // Prompt for flags
  for (const [, flagDef] of Object.entries(commandMeta.flags)) {
    const {char, description, hidden, name, options, type} = flagDef as any

    // Skip hidden flags, the prompt flag itself, and flags without descriptions
    if (!description || hidden || name === 'prompt') continue

    // Skip flags that already have values from command line
    if (argv.includes(`--${name}`) || (char && argv.includes(`-${char}`))) {
      continue
    }

    if (type === 'boolean') {
      // eslint-disable-next-line no-await-in-loop
      const {value} = await inquirer.prompt([{
        choices: [{name: 'yes', value: true}, {name: 'no', value: false}],
        message: description,
        name: 'value',
        type: 'list',
      }])

      if (value) {
        userInputByFlag.set(name, true)
      }
    // eslint-disable-next-line unicorn/consistent-destructuring
    } else if (options?.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      const {value} = await inquirer.prompt([{
        choices: options.map((opt: string) => ({name: opt, value: opt})),
        message: `Select the ${description}`,
        name: 'value',
        type: 'list',
      }])

      if (value) {
        userInputByFlag.set(name, value)
      }
    } else {
      // eslint-disable-next-line no-await-in-loop
      const {value} = await inquirer.prompt([{
        message: `${description} (optional - press "Enter" to bypass)`,
        name: 'value',
        type: 'input',
      }])

      if (value && value.trim()) {
        userInputByFlag.set(name, value)
      }
    }
  }

  // Build the new argv with collected inputs
  const newArgv: string[] = [commandId]

  for (const [, value] of userInputByArg) {
    newArgv.push(value)
  }

  for (const [flagName, flagValue] of userInputByFlag) {
    if (flagValue === true) {
      newArgv.push(`--${flagName}`)
    } else {
      newArgv.push(`--${flagName}`, flagValue)
    }
  }

  // Re-run the command with the collected inputs
  await run(newArgv, config)

  // Exit to prevent the original command from running
  // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
  process.exit(0)
}
