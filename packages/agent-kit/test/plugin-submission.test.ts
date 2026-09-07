import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  renderChatGptSubmission,
  renderClaudeSubmission,
  renderCursorSubmission,
  renderSubmissionReadme,
} from '../src/plugin-submission.js';

const CHATGPT_TEMPLATE = new URL('../submission/chatgpt-app-submission.json', import.meta.url);
const CLAUDE_TEMPLATE = new URL('../submission/claude-connector-submission.json', import.meta.url);
const CURSOR_TEMPLATE = new URL('../submission/cursor-plugin-submission.json', import.meta.url);
const SUBMISSION_README = new URL('../submission/README.md', import.meta.url);
const TOOL_NAMES = [
  'get_context',
  'list_apps',
  'inspect_app',
  'inspect_deployment',
  'get_logs',
  'get_metrics',
  'list_events',
  'get_session',
  'diagnose_app',
  'rollback_deployment',
] as const;

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe('ChatGPT plugin submission package', () => {
  it('matches the current import contract and the committed review template', () => {
    const submission = renderChatGptSubmission();
    expect(submission.$schema).toBe(
      'https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json',
    );
    expect(submission.schema_version).toBe(1);
    expect(submission.app_info).toMatchObject({
      display_name: 'Noodle Seed',
      category: 'DEVELOPER_TOOLS',
    });
    expect(submission.app_info.subtitle.length).toBeLessThanOrEqual(30);
    expect(Object.keys(submission.tools)).toEqual(TOOL_NAMES);
    expect(submission.test_cases).toHaveLength(5);
    expect(submission.negative_test_cases).toHaveLength(3);
    expect(JSON.parse(readFileSync(CHATGPT_TEMPLATE, 'utf8'))).toEqual(submission);
  });

  it('records every source annotation explicitly with one-sentence justifications', () => {
    const submission = renderChatGptSubmission();
    for (const [name, tool] of Object.entries(submission.tools)) {
      expect(Object.keys(tool.annotations).sort(), name).toEqual(
        ['destructiveHint', 'openWorldHint', 'readOnlyHint'].sort(),
      );
      expect(Object.values(tool.annotations).every((value) => typeof value === 'boolean')).toBe(
        true,
      );
      for (const justification of Object.values(tool.justifications)) {
        expect(justification.trim().endsWith('.'), `${name}: ${justification}`).toBe(true);
        expect(justification.trim().slice(0, -1)).not.toContain('.');
      }
    }
    expect(submission.tools.rollback_deployment.annotations).toEqual({
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
    });
    for (const name of TOOL_NAMES.filter((candidate) => candidate !== 'rollback_deployment')) {
      expect(submission.tools[name].annotations).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      });
    }
  });

  it('uses exact tool actions in positive cases and no actions in negative cases', () => {
    const submission = renderChatGptSubmission();
    for (const testCase of submission.test_cases) {
      expect(TOOL_NAMES).toContain(testCase.tools_triggered as (typeof TOOL_NAMES)[number]);
      expect(testCase.file_attachment_urls).toBeNull();
      expect(testCase.expected_output_url).toBeNull();
    }
    for (const testCase of submission.negative_test_cases) {
      expect(testCase.tools_triggered).toBeNull();
      expect(testCase.file_attachment_urls).toBeNull();
      expect(testCase.expected_output_url).toBeNull();
    }
  });
});

describe('Claude connector review package', () => {
  it('is a portal worksheet, not a claimed Anthropic upload schema', () => {
    const submission = renderClaudeSubmission();
    expect(submission.format).toBe('noodle-claude-directory-worksheet');
    expect(submission.format_version).toBe(1);
    expect(submission).not.toHaveProperty('$schema');
    expect(submission.portal_uploadable).toBe(false);
    expect(JSON.parse(readFileSync(CLAUDE_TEMPLATE, 'utf8'))).toEqual(submission);
  });

  it('captures the current remote MCP App listing and review boundaries', () => {
    const submission = renderClaudeSubmission();
    expect(submission.connection).toEqual({
      url: 'https://cloud.noodleseed.dev/developer/mcp',
      transport: 'streamable-http',
      url_mode: 'same-for-every-user',
    });
    expect(submission.authentication).toMatchObject({ type: 'oauth-2.0' });
    expect(submission.listing.name).toBe('Noodle Seed');
    expect(submission.listing.name.length).toBeLessThanOrEqual(100);
    expect(submission.listing.tagline.length).toBeLessThanOrEqual(55);
    expect(submission.listing.description.length).toBeLessThanOrEqual(2_000);
    expect(submission.listing.categories.length).toBeGreaterThanOrEqual(1);
    expect(submission.listing.categories.length).toBeLessThanOrEqual(5);
    expect(submission.capabilities.headless_workflows).toBe('complete');
    expect(submission.capabilities.rendered_mcp_app_ui).toBe('requires-live-host-evidence');
    expect(submission.capabilities.verified_widgets).toEqual([
      'app-overview',
      'deployment-detail',
      'operations',
      'analytics',
    ]);
  });
});

describe('Cursor plugin review package', () => {
  it('is a claim-safe marketplace worksheet bound to the native bundle', () => {
    const submission = renderCursorSubmission();
    expect(submission).toMatchObject({
      format: 'noodle-cursor-marketplace-worksheet',
      format_version: 1,
      portal_uploadable: false,
      listing: { name: 'Noodle Seed', category: 'developer-tools' },
      bundle: {
        manifest: '.cursor-plugin/plugin.json',
        mcp_config: 'mcp.json',
        skill: 'skills/noodle-seed/SKILL.md',
      },
      capabilities: {
        native_editor_plugin: true,
        headless_cli_mode: 'projected-plugin-capabilities',
        rendered_mcp_app_ui: 'requires-live-host-evidence',
      },
    });
    expect(JSON.parse(readFileSync(CURSOR_TEMPLATE, 'utf8'))).toEqual(submission);
  });
});

describe('shared submission safety contract', () => {
  it('keeps the committed operator guide generated from the same source', () => {
    expect(readFileSync(SUBMISSION_README, 'utf8')).toBe(renderSubmissionReadme());
  });

  it('uses production HTTPS URLs and preserves the coding-agent ownership boundary', () => {
    const chatgpt = renderChatGptSubmission();
    const claude = renderClaudeSubmission();
    const cursor = renderCursorSubmission();
    const text = serialized({ chatgpt, claude, cursor });
    expect(text).toContain('https://cloud.noodleseed.dev/developer/mcp');
    expect(text).toContain('https://noodleseed.com/privacy');
    expect(text).toContain('https://noodleseed.com/terms');
    expect(text).toMatch(/coding agent (?:writes|authors) the application source/i);
    expect(text).not.toMatch(/Noodle (?:writes|authors|generates) (?:the )?(?:code|source)/i);
    expect(text).not.toMatch(/vibe cod/i);
    expect(text).not.toMatch(/(?:^|[\s"`])\/(?:Users|home|tmp)\//m);
    expect(text).not.toMatch(/NOODLE_AUTH_TOKEN|oauthRefreshToken|\brefreshToken\b/);
    expect(text).not.toMatch(/\bnbk_[A-Za-z0-9]+\b|\bsk-[a-z0-9]{16,}\b/i);
  });
});
