import type { ModuleLogger } from './contract.js';

export type ModuleLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ModuleLogFields = Readonly<Record<string, unknown>>;

/** Adapt a module host logger to the child-capable shape used by service integrations. */
export interface AdaptedModuleLogger {
  readonly level: ModuleLogLevel;
  log(level: ModuleLogLevel, event: string, fields?: ModuleLogFields): void;
  debug(event: string, fields?: ModuleLogFields): void;
  info(event: string, fields?: ModuleLogFields): void;
  warn(event: string, fields?: ModuleLogFields): void;
  error(event: string, fields?: ModuleLogFields): void;
  child(fields: ModuleLogFields): AdaptedModuleLogger;
}

export function adaptModuleLogger(
  logger: ModuleLogger,
  base: ModuleLogFields = {},
): AdaptedModuleLogger {
  const fields = (extra?: ModuleLogFields): ModuleLogFields => ({ ...base, ...extra });
  const log = (level: ModuleLogLevel, event: string, extra?: ModuleLogFields): void => {
    logger[level](event, fields(extra));
  };
  return {
    level: 'debug',
    log,
    debug: (event, extra) => log('debug', event, extra),
    info: (event, extra) => log('info', event, extra),
    warn: (event, extra) => log('warn', event, extra),
    error: (event, extra) => log('error', event, extra),
    child: (extra) => adaptModuleLogger(logger, fields(extra)),
  };
}
