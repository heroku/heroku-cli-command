import {execSync} from 'node:child_process'

function toggle(onoff: string) {
  if (yubikey.platform !== 'darwin') return
  try {
    execSync(
      `osascript -e 'if application "yubiswitch" is running then tell application "yubiswitch" to ${onoff}'`,
      {stdio: 'inherit'},
    )
  } catch {}
}

export const yubikey = {
  disable: () => toggle('KeyOff'),
  enable: () => toggle('KeyOn'),
  platform: process.platform,
}
