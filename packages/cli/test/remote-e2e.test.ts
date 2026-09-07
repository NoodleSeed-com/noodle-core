import { describe, expect, it } from 'vitest';
import {
  mcpEndpoint,
  normalizeServiceUrl,
  parseArgs,
  parseResourceMetadataUrl,
} from '../../../scripts/remote-e2e.mjs';

// The deployed-backend validator's network steps run in the pipeline; these guard the pure wire
// helpers — the OAuth-challenge parse (the security-relevant assertion) and the endpoint joining.
describe('scripts/remote-e2e.mjs helpers', () => {
  it('extracts the resource_metadata URL from a bearer challenge', () => {
    const header = 'Bearer realm="noodle", resource_metadata="https://svc.run.app/.well-known/x"';
    expect(parseResourceMetadataUrl(header)).toBe('https://svc.run.app/.well-known/x');
  });

  it('returns undefined when the challenge has no resource_metadata (owner-only vs open)', () => {
    expect(parseResourceMetadataUrl('Bearer realm="noodle"')).toBeUndefined();
    expect(parseResourceMetadataUrl(undefined)).toBeUndefined();
    expect(parseResourceMetadataUrl(null)).toBeUndefined();
  });

  it('joins the deployed MCP endpoint without a double slash', () => {
    expect(mcpEndpoint('https://svc.run.app/')).toBe('https://svc.run.app/o/pipeline/hello/mcp');
    expect(mcpEndpoint('https://svc.run.app')).toBe('https://svc.run.app/o/pipeline/hello/mcp');
  });

  it('normalizes trailing slashes off the service URL', () => {
    expect(normalizeServiceUrl('https://svc.run.app///')).toBe('https://svc.run.app');
  });

  it('requires --service and defaults --version to 1', () => {
    expect(() => parseArgs([])).toThrow(/--service/);
    expect(parseArgs(['--service', 'https://svc.run.app'])).toEqual({
      service: 'https://svc.run.app',
      version: '1',
    });
    expect(parseArgs(['--service', 'https://svc.run.app', '--version', '3']).version).toBe('3');
  });
});
