import type {Answers, StreamOptions} from 'inquirer'

class Prompter {
  /**
   * Wraps inquirer's prompt module so that prompt UI (question text, mask
   * characters, cursor escapes) writes to stderr by default. Routing to stdout
   * — inquirer's default — corrupts piped output (e.g. `heroku run … | tee`).
   *
   * Tests can override `input` and/or `output` via the optional second arg.
   */
  async prompt<T extends Answers = Answers>(
    questions: any[],
    streamOpts: StreamOptions = {},
  ): Promise<T> {
    const inquirer = (await import('inquirer')).default
    const promptModule = inquirer.createPromptModule({
      output: process.stderr,
      ...streamOpts,
    })
    return promptModule(questions) as Promise<T>
  }
}

export const prompter = new Prompter()
