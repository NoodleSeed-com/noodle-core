import { parse as parseYaml } from 'yaml';

/**
 * Parse a manifest document, JSON-first: yaml.parse allocates ~50x JSON.parse's transient
 * memory on the multi-megabyte JSON manifests the CLI sends — it OOM-killed 512MiB hosted
 * instances (IMPLEMENTATION-LOG 2026-08-19). Non-JSON falls back to YAML, errors unchanged.
 */
export function parseManifestDocument(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return parseYaml(source);
  }
}

/** Shared shape guard for walking parsed manifest documents. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
