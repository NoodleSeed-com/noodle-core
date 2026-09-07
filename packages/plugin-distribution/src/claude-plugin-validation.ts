import type { HostPackageAdapterInput, HostPackageTargetIssue } from '@noodle-borg/agent-packaging';
import { isPublicHttpsUrl } from './public-url.js';

const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateClaudePluginInput(
  input: HostPackageAdapterInput,
): readonly HostPackageTargetIssue[] {
  const issues: HostPackageTargetIssue[] = [];
  if (!STRICT_SEMVER.test(input.appPackage.app.version)) {
    issues.push(
      issue(
        'claude_plugin_version_invalid',
        'appPackage.app.version',
        'The Claude plugin version must use strict semantic versioning.',
      ),
    );
  }
  if (!isPublicHttpsUrl(input.mcpServer.url)) {
    issues.push(
      issue(
        'claude_plugin_public_url_required',
        'mcpServer.url',
        'A distributable Claude plugin requires a public production HTTPS MCP URL.',
      ),
    );
  }
  return issues;
}

function issue(code: string, path: string, message: string): HostPackageTargetIssue {
  return { severity: 'error', code, path, message };
}
