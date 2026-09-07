import type { ArtifactTool } from '@noodle-borg/compiler';

/**
 * What every `noodle check` audit produces, and the one formatter they share.
 *
 * Extracted ahead of the per-target audits rather than left in `mcp-apps.ts`: the target modules need
 * both, and `mcp-apps.ts` needs the target modules, so anything else here is an import cycle.
 */
export interface AuditFinding {
  readonly code: string;
  readonly severity: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly cause: string;
  readonly fix: string;
  readonly next: string;
}

export function toolNames(tools: readonly ArtifactTool[]): string {
  return tools.map((tool) => tool.name).join(', ');
}

/** Byte sizes in finding messages. Lives here because the widget-size findings are its only rule-side use. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
