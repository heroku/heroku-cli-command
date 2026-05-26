import type {Answers} from 'inquirer'

class Prompter {
  async prompt<T extends Answers = Answers>(questions: any[]): Promise<T> {
    const inquirer = (await import('inquirer')).default
    return inquirer.prompt<T>(questions) as Promise<T>
  }
}

export const prompter = new Prompter()
