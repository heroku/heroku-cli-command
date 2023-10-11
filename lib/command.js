"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Command = void 0;
const tslib_1 = require("tslib");
const core_1 = require("@oclif/core");
const util_1 = require("util");
const pjson = require('../package.json');
const deps_1 = tslib_1.__importDefault(require("./deps"));
const deprecatedCLI = (0, util_1.deprecate)(() => {
    return require('cli-ux').cli;
}, 'this.out and this.cli is deprecated. Please import "CliUx" from the @oclif/core module directly instead.');
class Command extends core_1.Command {
    constructor() {
        super(...arguments);
        this.base = `${pjson.name}@${pjson.version}`;
    }
    get heroku() {
        if (this._heroku)
            return this._heroku;
        this._heroku = new deps_1.default.APIClient(this.config);
        return this._heroku;
    }
    get legacyHerokuClient() {
        if (this._legacyHerokuClient)
            return this._legacyHerokuClient;
        const HerokuClient = require('heroku-client');
        const options = {
            debug: this.config.debug,
            host: `${this.heroku.defaults.protocol || 'https:'}//${this.heroku.defaults.host ||
                'api.heroku.com'}`,
            token: this.heroku.auth,
            userAgent: this.heroku.defaults.headers['user-agent'],
        };
        this._legacyHerokuClient = new HerokuClient(options);
        return this._legacyHerokuClient;
    }
    get cli() {
        return deprecatedCLI();
    }
    get out() {
        return deprecatedCLI();
    }
}
exports.Command = Command;
