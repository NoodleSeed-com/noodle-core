import pkg from '../package.json' with { type: 'json' };

export const AGENT_KIT_VERSION: string = pkg.version;
