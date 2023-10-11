"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.team = void 0;
const core_1 = require("@oclif/core");
exports.team = core_1.Flags.custom({
    char: 't',
    description: 'team to use',
    default: async ({ flags }) => {
        const { HEROKU_ORGANIZATION: org, HEROKU_TEAM: team } = process.env;
        if (flags.org)
            return flags.org;
        if (team)
            return team;
        if (org)
            return org;
    },
});
