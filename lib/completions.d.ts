import { Interfaces } from '@oclif/core';
declare type CompletionContext = {
    args?: {
        [name: string]: string;
    };
    flags?: {
        [name: string]: string;
    };
    argv?: string[];
    config: Interfaces.Config;
};
declare type Completion = {
    skipCache?: boolean;
    cacheDuration?: number;
    cacheKey?(ctx: CompletionContext): Promise<string>;
    options(ctx: CompletionContext): Promise<string[]>;
};
export declare const oneDay: number;
export declare const herokuGet: (resource: string, ctx: {
    config: Interfaces.Config;
}) => Promise<string[]>;
export declare const AppCompletion: Completion;
export declare const AppAddonCompletion: Completion;
export declare const AppDynoCompletion: Completion;
export declare const BuildpackCompletion: Completion;
export declare const DynoSizeCompletion: Completion;
export declare const FileCompletion: Completion;
export declare const PipelineCompletion: Completion;
export declare const ProcessTypeCompletion: Completion;
export declare const RegionCompletion: Completion;
export declare const RemoteCompletion: Completion;
export declare const RoleCompletion: Completion;
export declare const ScopeCompletion: Completion;
export declare const SpaceCompletion: Completion;
export declare const StackCompletion: Completion;
export declare const StageCompletion: Completion;
export declare const TeamCompletion: Completion;
export {};
