import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { claudeWidgetDomain, projectWidgetResourceMeta } from '../src/widget/domain-projection.js';

const MCP_URL = 'https://saad-apps.cloud.noodleseed.dev/todoist/v1/mcp';
const expectedClaudeDomain = `${createHash('sha256')
  .update(MCP_URL)
  .digest('hex')
  .slice(0, 32)}.claudemcpcontent.com`;

describe('widget domain projection', () => {
  it('derives Claude domain from the canonical MCP URL', () => {
    expect(claudeWidgetDomain(`${MCP_URL}?ignored=1`)).toBe(expectedClaudeDomain);
  });

  it('rejects non-http and malformed hash inputs', () => {
    expect(claudeWidgetDomain('ui://todoist/widget')).toBeUndefined();
    expect(claudeWidgetDomain('not a URL')).toBeUndefined();
  });

  it('preserves generic ui.domain and adds the ChatGPT alias without mutation', () => {
    const meta = Object.freeze({
      ui: Object.freeze({ domain: 'https://widgets.example.com', prefersBorder: true }),
      extension: 'kept',
    });
    expect(projectWidgetResourceMeta(meta)).toEqual({
      ui: { domain: 'https://widgets.example.com', prefersBorder: true },
      extension: 'kept',
      'openai/widgetDomain': 'https://widgets.example.com',
    });
    expect(meta).not.toHaveProperty('openai/widgetDomain');
  });

  it('uses Claude domain and preserves an explicit OpenAI alias', () => {
    const meta = {
      ui: {
        domain: 'https://widgets.example.com',
        csp: { connectDomains: ['https://api.example.com'] },
      },
      'openai/widgetDomain': 'https://reviewed.example.com',
    };
    expect(projectWidgetResourceMeta(meta, { host: 'claude', mcpServerUrl: MCP_URL })).toEqual({
      ui: {
        domain: expectedClaudeDomain,
        csp: { connectDomains: ['https://api.example.com'] },
      },
      'openai/widgetDomain': 'https://reviewed.example.com',
    });
  });

  it('omits only ui.domain for Claude when no safe MCP URL exists', () => {
    expect(
      projectWidgetResourceMeta(
        { ui: { domain: 'https://widgets.example.com', prefersBorder: false } },
        { host: 'claude' },
      ),
    ).toEqual({
      ui: { prefersBorder: false },
      'openai/widgetDomain': 'https://widgets.example.com',
    });
  });

  it('returns metadata unchanged when ui.domain is absent', () => {
    const meta = { ui: { prefersBorder: true }, extension: { value: 1 } };
    expect(projectWidgetResourceMeta(meta, { host: 'claude', mcpServerUrl: MCP_URL })).toBe(meta);
  });
});
