import {
  type HostPackageAdapter,
  type HostPackageRequest,
  type HostPackageResult,
  packageHostTarget,
} from '@noodle-borg/agent-packaging';
import { renderClaudePlugin } from './claude-plugin-render.js';
import { validateClaudePluginInput } from './claude-plugin-validation.js';

export const CLAUDE_PLUGIN_ADAPTER_VERSION = '1.0.0';

/** Render one installable Claude Code plugin repository from the canonical App Package. */
export function packageClaudePlugin(request: HostPackageRequest): HostPackageResult {
  const adapter: HostPackageAdapter = {
    target: 'claude',
    version: CLAUDE_PLUGIN_ADAPTER_VERSION,
    validate: validateClaudePluginInput,
    render: renderClaudePlugin,
  };
  return packageHostTarget(request, adapter);
}
