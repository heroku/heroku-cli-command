"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGitRemotes = exports.configRemote = exports.Git = void 0;
const errors_1 = require("@oclif/core/lib/errors");
const vars_1 = require("./vars");
class Git {
    get remotes() {
        return this.exec('remote -v')
            .split('\n')
            .filter(l => l.endsWith('(fetch)'))
            .map(l => {
            const [name, url] = l.split('\t');
            return { name, url: url.split(' ')[0] };
        });
    }
    exec(cmd) {
        const { execSync: exec } = require('child_process');
        try {
            return exec(`git ${cmd}`, {
                encoding: 'utf8',
                stdio: [null, 'pipe', null],
            });
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                throw new errors_1.CLIError('Git must be installed to use the Heroku CLI.  See instructions here: http://git-scm.com');
            }
            throw error;
        }
    }
}
exports.Git = Git;
function configRemote() {
    const git = new Git();
    try {
        return git.exec('config heroku.remote').trim();
    }
    catch (_a) { }
}
exports.configRemote = configRemote;
function getGitRemotes(onlyRemote) {
    const git = new Git();
    const appRemotes = [];
    let remotes;
    try {
        remotes = git.remotes;
    }
    catch (_a) {
        return [];
    }
    for (const remote of remotes) {
        if (onlyRemote && remote.name !== onlyRemote)
            continue;
        for (const prefix of vars_1.vars.gitPrefixes) {
            const suffix = '.git';
            const match = remote.url.match(`${prefix}(.*)${suffix}`);
            if (!match)
                continue;
            appRemotes.push({
                app: match[1],
                remote: remote.name,
            });
        }
    }
    return appRemotes;
}
exports.getGitRemotes = getGitRemotes;
