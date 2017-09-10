// @flow

import supports from 'supports-color'
import chalk from 'chalk'
import ansiStyles from 'ansi-styles'

export const CustomColors = {
  supports,
  // map gray -> dim because it's not solarized compatible
  gray: (s: string) => chalk.dim(s),
  grey: (s: string) => chalk.dim(s),
  attachment: (s: string) => chalk.cyan(s),
  addon: (s: string) => chalk.yellow(s),
  configVar: (s: string) => chalk.green(s),
  release: (s: string) => chalk.blue.bold(s),
  cmd: (s: string) => chalk.cyan.bold(s),
  app: (s: string) => CustomColors.heroku(`⬢ ${s}`),
  heroku: (s: string) => {
    if (!CustomColors.supports) return s
    let has256 = CustomColors.supports.has256 || (process.env.TERM || '').indexOf('256') !== -1
    return has256 ? '\u001b[38;5;104m' + s + ansiStyles.reset.open : chalk.magenta(s)
  }
}

export const color = new Proxy(chalk, {
  get: (chalk, name) => {
    if (CustomColors[name]) return CustomColors[name]
    return chalk[name]
  }
})
