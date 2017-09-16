import * as supports from 'supports-color'
import * as ansiStyles from 'ansi-styles'
import * as chalk from 'chalk'

const CustomColors = {
  // map gray -> dim because it's not solarized compatible
  gray: chalk.dim,
  grey: chalk.dim,
  cmd: chalk.cyan.bold,
  attachment: chalk.cyan,
  addon: chalk.yellow,
  configVar: chalk.green,
  release: chalk.blue.bold,
  app: (s: string) => CustomColors.heroku(`⬢ ${s}`),
  heroku: (s: string) => {
    let has256 = supports.has256 || (process.env.TERM || '').indexOf('256') !== -1
    return has256 ? '\u001b[38;5;104m' + s + ansiStyles.reset.open : chalk.magenta(s)
  },
}

export const color = new Proxy(chalk, {
  get: (chalk, name) => {
    if ((<any>CustomColors)[name]) return (<any>CustomColors)[name]
    return (<any>chalk)[name]
  },
}) as typeof CustomColors & typeof chalk
