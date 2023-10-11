"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeamCompletion = exports.StageCompletion = exports.StackCompletion = exports.SpaceCompletion = exports.ScopeCompletion = exports.RoleCompletion = exports.RemoteCompletion = exports.RegionCompletion = exports.ProcessTypeCompletion = exports.PipelineCompletion = exports.FileCompletion = exports.DynoSizeCompletion = exports.BuildpackCompletion = exports.AppDynoCompletion = exports.AppAddonCompletion = exports.AppCompletion = exports.herokuGet = exports.oneDay = void 0;
const tslib_1 = require("tslib");
const errors_1 = require("@oclif/core/lib/errors");
const path = tslib_1.__importStar(require("path"));
const deps_1 = tslib_1.__importDefault(require("./deps"));
const git_1 = require("./git");
exports.oneDay = 60 * 60 * 24;
const herokuGet = async (resource, ctx) => {
    const heroku = new deps_1.default.APIClient(ctx.config);
    let { body: resources } = await heroku.get(`/${resource}`);
    if (typeof resources === 'string')
        resources = JSON.parse(resources);
    return resources.map((a) => a.name).sort();
};
exports.herokuGet = herokuGet;
exports.AppCompletion = {
    cacheDuration: exports.oneDay,
    options: async (ctx) => {
        const apps = await (0, exports.herokuGet)('apps', ctx);
        return apps;
    },
};
exports.AppAddonCompletion = {
    cacheDuration: exports.oneDay,
    cacheKey: async (ctx) => {
        return ctx.flags && ctx.flags.app ? `${ctx.flags.app}_addons` : '';
    },
    options: async (ctx) => {
        const addons = ctx.flags && ctx.flags.app ? await (0, exports.herokuGet)(`apps/${ctx.flags.app}/addons`, ctx) : [];
        return addons;
    },
};
exports.AppDynoCompletion = {
    cacheDuration: exports.oneDay,
    cacheKey: async (ctx) => {
        return ctx.flags && ctx.flags.app ? `${ctx.flags.app}_dynos` : '';
    },
    options: async (ctx) => {
        const dynos = ctx.flags && ctx.flags.app ? await (0, exports.herokuGet)(`apps/${ctx.flags.app}/dynos`, ctx) : [];
        return dynos;
    },
};
exports.BuildpackCompletion = {
    skipCache: true,
    options: async () => {
        return [
            'heroku/ruby',
            'heroku/nodejs',
            'heroku/clojure',
            'heroku/python',
            'heroku/java',
            'heroku/gradle',
            'heroku/scala',
            'heroku/php',
            'heroku/go',
        ];
    },
};
exports.DynoSizeCompletion = {
    cacheDuration: exports.oneDay * 90,
    options: async (ctx) => {
        const sizes = await (0, exports.herokuGet)('dyno-sizes', ctx);
        return sizes;
    },
};
exports.FileCompletion = {
    skipCache: true,
    options: async () => {
        const files = await deps_1.default.file.readdir(process.cwd());
        return files;
    },
};
exports.PipelineCompletion = {
    cacheDuration: exports.oneDay,
    options: async (ctx) => {
        const pipelines = await (0, exports.herokuGet)('pipelines', ctx);
        return pipelines;
    },
};
exports.ProcessTypeCompletion = {
    skipCache: true,
    options: async () => {
        let types = [];
        const procfile = path.join(process.cwd(), 'Procfile');
        try {
            const buff = await deps_1.default.file.readFile(procfile);
            types = buff
                .toString()
                .split('\n')
                .map((s) => {
                if (!s)
                    return false;
                const m = s.match(/^([\w-]+)/);
                return m ? m[0] : false;
            })
                .filter((t) => t);
        }
        catch (error) {
            if (error instanceof errors_1.CLIError && error.code !== 'ENOENT')
                throw error;
        }
        return types;
    },
};
exports.RegionCompletion = {
    cacheDuration: exports.oneDay * 7,
    options: async (ctx) => {
        const regions = await (0, exports.herokuGet)('regions', ctx);
        return regions;
    },
};
exports.RemoteCompletion = {
    skipCache: true,
    options: async () => {
        const remotes = (0, git_1.getGitRemotes)((0, git_1.configRemote)());
        return remotes.map(r => r.remote);
    },
};
exports.RoleCompletion = {
    skipCache: true,
    options: async () => {
        return ['admin', 'collaborator', 'member', 'owner'];
    },
};
exports.ScopeCompletion = {
    skipCache: true,
    options: async () => {
        return ['global', 'identity', 'read', 'write', 'read-protected', 'write-protected'];
    },
};
exports.SpaceCompletion = {
    cacheDuration: exports.oneDay,
    options: async (ctx) => {
        const spaces = await (0, exports.herokuGet)('spaces', ctx);
        return spaces;
    },
};
exports.StackCompletion = {
    cacheDuration: exports.oneDay,
    options: async (ctx) => {
        const stacks = await (0, exports.herokuGet)('stacks', ctx);
        return stacks;
    },
};
exports.StageCompletion = {
    skipCache: true,
    options: async () => {
        return ['test', 'review', 'development', 'staging', 'production'];
    },
};
exports.TeamCompletion = {
    cacheDuration: exports.oneDay,
    options: async (ctx) => {
        const teams = await (0, exports.herokuGet)('teams', ctx);
        return teams;
    },
};
