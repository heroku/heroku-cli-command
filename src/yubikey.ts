function toggle(onoff: string) {
  const cp = require('child_process')
  if (yubikey.platform !== 'darwin') return
  try {
    cp.execSync(
      `osascript -e 'if application "yubiswitch" is running then tell application "yubiswitch" to ${onoff}'`,
      { stdio: 'inherit' },
    )
  } catch (err) {}
}

export const yubikey = {
  disable: () => toggle('KeyOff'),
  enable: () => toggle('KeyOn'),
  platform: process.platform,
}
