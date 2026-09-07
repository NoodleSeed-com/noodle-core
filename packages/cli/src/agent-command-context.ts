import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AgentProjectMetadata, AgentTarget } from '@noodle-borg/agent-kit';
import { readPluginCompatibility } from './plugin-mode/compatibility.js';
import { readProjectLink, readResolvedProjectConfig } from './project.js';

const SAFE_AGENT_ENVIRONMENT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function resolveAgentProjectMetadata(project: string): AgentProjectMetadata {
  const projectDefaults = readResolvedProjectConfig(project);
  const link = readProjectLink(project);
  const org = link?.org ?? projectDefaults.org;
  const app = link?.app ?? projectDefaults.app;
  const env = safeAgentEnvironment(projectDefaults.env);
  return Object.assign(
    {},
    projectDefaults.name !== undefined ? { name: projectDefaults.name } : {},
    projectDefaults.entrypoint !== undefined ? { entrypoint: projectDefaults.entrypoint } : {},
    env !== undefined ? { env } : {},
    projectDefaults.accessMode !== undefined ? { accessMode: projectDefaults.accessMode } : {},
    projectDefaults.template !== undefined ? { template: projectDefaults.template } : {},
    org !== undefined ? { org } : {},
    app !== undefined ? { app } : {},
  );
}

/** Agent instructions accept only the same bounded slug shape as hosted environment identifiers. */
function safeAgentEnvironment(value: string | undefined): string | undefined {
  return value !== undefined && SAFE_AGENT_ENVIRONMENT.test(value) ? value : undefined;
}

export function isSkillsUpdateContext(env: NodeJS.ProcessEnv): boolean {
  if (env.NOODLE_DISABLE_UPDATE_CHECK !== undefined && env.NOODLE_DISABLE_UPDATE_CHECK !== '') {
    return false;
  }
  if (env.CI !== undefined && env.CI !== '') return false;
  return process.stderr.isTTY === true;
}

export function pluginRequiredAgentKitVersion(env: NodeJS.ProcessEnv): string | undefined {
  const compatibilityFile = env.NOODLE_PLUGIN_COMPATIBILITY_FILE;
  if (compatibilityFile === undefined) return undefined;
  const manifest = readPluginCompatibility(compatibilityFile);
  return manifest.schemaVersion === 2 ? manifest.agentKitVersion : undefined;
}

export function displayAgentName(target: AgentTarget): string {
  return target === 'codex' ? 'Codex' : 'Claude Code';
}

export function commandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const path = env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir && existsSync(join(dir, command))) return true;
  }
  return false;
}
