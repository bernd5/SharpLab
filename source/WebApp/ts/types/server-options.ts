import type { TargetName } from '../helpers/targets';

export interface ServerOptions {
    readonly 'x-optimize': 'release'|'debug';
    readonly 'x-target': TargetName|string;
    readonly 'x-no-cache'?: boolean;
}