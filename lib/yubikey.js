"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.yubikey = void 0;
function toggle(onoff) {
    const cp = require('child_process');
    if (exports.yubikey.platform !== 'darwin')
        return;
    try {
        cp.execSync(`osascript -e 'if application "yubiswitch" is running then tell application "yubiswitch" to ${onoff}'`, { stdio: 'inherit' });
    }
    catch (_a) { }
}
exports.yubikey = {
    disable: () => toggle('KeyOff'),
    enable: () => toggle('KeyOn'),
    platform: process.platform,
};
