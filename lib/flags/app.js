"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.remote = exports.app = void 0;
const core_1 = require("@oclif/core");
const errors_1 = require("@oclif/core/lib/errors");
const git_1 = require("../git");
class MultipleRemotesError extends errors_1.CLIError {
    constructor(gitRemotes) {
        super(`Multiple apps in git remotes
  Usage: --remote ${gitRemotes[1].remote}
     or: --app ${gitRemotes[1].app}
  Your local git repository has more than 1 app referenced in git remotes.
  Because of this, we can't determine which app you want to run this command against.
  Specify the app you want with --app or --remote.
  Heroku remotes in repo:
  ${gitRemotes.map(r => `${r.app} (${r.remote})`).join('\n')}

  https://devcenter.heroku.com/articles/multiple-environments`);
    }
}
exports.app = core_1.Flags.custom({
    char: 'a',
    description: 'app to run command against',
    default: async ({ options, flags }) => {
        const envApp = process.env.HEROKU_APP;
        if (envApp)
            return envApp;
        const gitRemotes = (0, git_1.getGitRemotes)(flags.remote || (0, git_1.configRemote)());
        if (gitRemotes.length === 1)
            return gitRemotes[0].app;
        if (flags.remote && gitRemotes.length === 0) {
            (0, errors_1.error)(`remote ${flags.remote} not found in git remotes`);
        }
        if (gitRemotes.length > 1 && options.required) {
            throw new MultipleRemotesError(gitRemotes);
        }
    },
});
exports.remote = core_1.Flags.custom({
    char: 'r',
    description: 'git remote of app to use',
});
