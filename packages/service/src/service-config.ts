import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITY_NAMES,
  type CapabilityName,
  isServiceProfileName,
  SERVICE_PROFILE_NAMES,
  type ServiceProfileName,
} from '@noodle-borg/capabilities';
import type { ModuleInput } from '@noodle-borg/service-modules';
import { parse as parseYaml } from 'yaml';

export interface NoodleServiceConfig {
  readonly profile: ServiceProfileName;
  readonly org?: { readonly slug?: string; readonly template?: AgencyOrgTemplate };
  readonly identity?: { readonly admin?: { readonly provider?: string } };
  readonly access?: { readonly mode?: string };
  readonly audit?: {
    readonly enabled?: boolean;
    readonly store?: 'postgres' | 'memory';
    readonly mode?: 'enforce' | 'observe';
  };
  readonly controls?: { readonly preset?: string; readonly rateLimits?: unknown };
  readonly observability?: ObservabilityConfig;
  readonly secrets?: { readonly enabled?: boolean };
  readonly connectors?: { readonly enabled?: boolean };
  readonly apps?: { readonly enabled?: boolean };
  readonly modules?: readonly ModuleInput[];
}

export type ObservabilityLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ObservabilityLogSink = 'stdout' | 'stderr' | 'none';
export type ObservabilityLogFormat = 'json' | 'pretty';

export interface ObservabilityConfig {
  readonly enabled?: boolean;
  readonly logs?: {
    readonly level?: ObservabilityLogLevel;
    readonly sink?: ObservabilityLogSink;
    readonly format?: ObservabilityLogFormat;
    readonly samplingRate?: number;
  };
  readonly otel?: {
    readonly enabled?: boolean;
    readonly endpoint?: string;
  };
  readonly sentry?: {
    readonly enabled?: boolean;
    readonly dsn?: string;
  };
  readonly userAppLogs?: {
    readonly enabled?: boolean;
    readonly retentionDays?: number;
    readonly maxEventsPerExecution?: number;
  };
}

const AGENCY_ORG_TEMPLATES = ['small-business', 'mid-market', 'enterprise'] as const;
type AgencyOrgTemplate = (typeof AGENCY_ORG_TEMPLATES)[number];

export type ServiceConfigSource =
  | { readonly kind: 'none' }
  | { readonly kind: 'yaml'; readonly path: string }
  | { readonly kind: 'typescript'; readonly path: string };

export function defineNoodleService(config: NoodleServiceConfig): NoodleServiceConfig {
  return config;
}

export function expandServiceProfile(profile: ServiceProfileName): readonly CapabilityName[] {
  switch (profile) {
    case 'noodle-cloud-managed':
      return ordered([
        'identity',
        'access',
        'controls',
        'observability',
        'secrets',
        'connectors',
        'apps',
      ]);
    case 'open-core':
      return ordered(['observability', 'secrets', 'connectors']);
    case 'enterprise-governed':
      return ordered([
        'identity',
        'access',
        'controls',
        'audit',
        'observability',
        'secrets',
        'connectors',
      ]);
    case 'public-saas':
      return ordered([
        'identity',
        'access',
        'controls',
        'audit',
        'observability',
        'secrets',
        'connectors',
        'apps',
      ]);
    case 'agency-managed':
      return ordered([
        'identity',
        'access',
        'controls',
        'audit',
        'observability',
        'secrets',
        'connectors',
        'apps',
      ]);
  }
}

export function parseNoodleServiceYaml(source: string):
  | {
      readonly ok: true;
      readonly config: NoodleServiceConfig;
      readonly capabilities: readonly CapabilityName[];
    }
  | { readonly ok: false; readonly error: string } {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'service config must be a YAML object' };
  }
  const object = raw as Record<string, unknown>;
  const profile = object.profile;
  if (!isServiceProfileName(profile)) {
    return {
      ok: false,
      error: `unknown service profile "${String(profile)}"; expected one of ${SERVICE_PROFILE_NAMES.join(', ')}`,
    };
  }
  const config = object as unknown as NoodleServiceConfig;
  const template = config.org?.template;
  if (template !== undefined && !isAgencyOrgTemplate(template)) {
    return {
      ok: false,
      error: `unknown org template "${String(template)}"; expected one of ${AGENCY_ORG_TEMPLATES.join(', ')}`,
    };
  }
  const audit = config.audit;
  if (audit?.store !== undefined && audit.store !== 'postgres' && audit.store !== 'memory') {
    return {
      ok: false,
      error: `unknown audit store "${String(audit.store)}"; expected one of postgres, memory`,
    };
  }
  if (audit?.mode !== undefined && audit.mode !== 'enforce' && audit.mode !== 'observe') {
    return {
      ok: false,
      error: `unknown audit mode "${String(audit.mode)}"; expected one of enforce, observe`,
    };
  }
  const observabilityError = validateObservabilityConfig(config.observability);
  if (observabilityError !== undefined) return { ok: false, error: observabilityError };
  return { ok: true, config, capabilities: capabilitiesForConfig(config) };
}

function validateObservabilityConfig(config: ObservabilityConfig | undefined): string | undefined {
  const logs = config?.logs;
  if (
    logs?.level !== undefined &&
    logs.level !== 'debug' &&
    logs.level !== 'info' &&
    logs.level !== 'warn' &&
    logs.level !== 'error'
  ) {
    return `unknown observability log level "${String(logs.level)}"; expected one of debug, info, warn, error`;
  }
  if (
    logs?.sink !== undefined &&
    logs.sink !== 'stdout' &&
    logs.sink !== 'stderr' &&
    logs.sink !== 'none'
  ) {
    return `unknown observability log sink "${String(logs.sink)}"; expected one of stdout, stderr, none`;
  }
  if (logs?.format !== undefined && logs.format !== 'json' && logs.format !== 'pretty') {
    return `unknown observability log format "${String(logs.format)}"; expected one of json, pretty`;
  }
  if (logs?.samplingRate !== undefined && !isUnitInterval(logs.samplingRate)) {
    return 'observability logs samplingRate must be between 0 and 1';
  }
  const retentionDays = config?.userAppLogs?.retentionDays;
  if (retentionDays !== undefined && !isPositiveInteger(retentionDays)) {
    return 'observability userAppLogs retentionDays must be a positive integer';
  }
  const maxEvents = config?.userAppLogs?.maxEventsPerExecution;
  if (maxEvents !== undefined && !isPositiveInteger(maxEvents)) {
    return 'observability userAppLogs maxEventsPerExecution must be a positive integer';
  }
  return undefined;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

export function capabilitiesForConfig(config: NoodleServiceConfig): readonly CapabilityName[] {
  const enabled = new Set<CapabilityName>(expandServiceProfile(config.profile));
  for (const name of CAPABILITY_NAMES) {
    const block = (config as unknown as Record<string, unknown>)[name];
    if (block === undefined) continue;
    if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
      const explicit = (block as { enabled?: unknown }).enabled;
      if (explicit === false) enabled.delete(name);
      else enabled.add(name);
    }
  }
  return CAPABILITY_NAMES.filter((name) => enabled.has(name));
}

export function resolveServiceConfigSource(input: {
  readonly dir?: string;
  readonly explicit?: 'yaml' | 'typescript';
}):
  | { readonly ok: true; readonly source: ServiceConfigSource }
  | { readonly ok: false; readonly error: string } {
  const dir = input.dir ?? process.cwd();
  const yaml = join(dir, 'noodle.service.yaml');
  const ts = join(dir, 'noodle.service.ts');
  const hasYaml = existsSync(yaml);
  const hasTs = existsSync(ts);
  if (input.explicit === 'yaml') return { ok: true, source: { kind: 'yaml', path: yaml } };
  if (input.explicit === 'typescript')
    return { ok: true, source: { kind: 'typescript', path: ts } };
  if (hasYaml && hasTs) {
    return {
      ok: false,
      error:
        'Both noodle.service.yaml and noodle.service.ts exist; choose one service config source explicitly.',
    };
  }
  if (hasYaml) return { ok: true, source: { kind: 'yaml', path: yaml } };
  if (hasTs) return { ok: true, source: { kind: 'typescript', path: ts } };
  return { ok: true, source: { kind: 'none' } };
}

function ordered(names: readonly CapabilityName[]): readonly CapabilityName[] {
  const set = new Set(names);
  return CAPABILITY_NAMES.filter((name) => set.has(name));
}

function isAgencyOrgTemplate(value: unknown): value is AgencyOrgTemplate {
  return typeof value === 'string' && AGENCY_ORG_TEMPLATES.includes(value as AgencyOrgTemplate);
}
