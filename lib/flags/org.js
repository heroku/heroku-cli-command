"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.org = void 0;
const core_1 = require("@oclif/core");
exports.org = core_1.Flags.custom({
    char: 'o',
    default: () => process.env.HEROKU_ORGANIZATION,
    description: 'name of org',
    hidden: true,
});
