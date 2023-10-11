"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pipeline = void 0;
const core_1 = require("@oclif/core");
exports.pipeline = core_1.Flags.custom({
    char: 'p',
    description: 'name of pipeline',
});
