/// <reference types="node" />
import oclif = require('@oclif/core');
import HTTP = require('http-call');
import netrc = require('netrc-parser');
import apiClient = require('./api-client');
import file = require('./file');
import flags = require('./flags');
import git = require('./git');
import mutex = require('./mutex');
export declare const deps: {
    readonly cli: typeof oclif.ux;
    readonly HTTP: typeof HTTP;
    readonly netrc: netrc.Netrc;
    readonly Mutex: typeof mutex.Mutex;
    readonly yubikey: {
        disable: () => void;
        enable: () => void;
        platform: NodeJS.Platform;
    };
    readonly APIClient: typeof apiClient.APIClient;
    readonly file: typeof file;
    readonly flags: typeof flags;
    readonly Git: typeof git.Git;
};
export default deps;
