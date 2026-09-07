import { describe, expect, it, vi } from 'vitest';
import { discoverIssuerMetadata, issuerMetadataCandidates } from '../src/discovery.js';

describe('discoverIssuerMetadata', () => {
  it('uses MCP discovery order for a root issuer', () => {
    expect(
      issuerMetadataCandidates('https://id.example.com/').map((candidate) => candidate.url),
    ).toEqual([
      'https://id.example.com/.well-known/oauth-authorization-server',
      'https://id.example.com/.well-known/openid-configuration',
    ]);
  });

  it('uses path-inserted discovery before compatibility fallbacks for a path issuer', () => {
    expect(
      issuerMetadataCandidates('https://app.acmehr.example/oauth').map(
        (candidate) => candidate.url,
      ),
    ).toEqual([
      'https://app.acmehr.example/.well-known/oauth-authorization-server/oauth',
      'https://app.acmehr.example/.well-known/openid-configuration/oauth',
      'https://app.acmehr.example/oauth/.well-known/openid-configuration',
      'https://app.acmehr.example/oauth/.well-known/oauth-authorization-server',
    ]);
  });

  it('tries RFC 8414 metadata before OpenID Connect metadata', async () => {
    const load = vi
      .fn<(url: string) => Promise<{ issuer: string }>>()
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ issuer: 'https://id.example.com' });

    await expect(discoverIssuerMetadata('https://id.example.com/', load)).resolves.toEqual({
      metadata: { issuer: 'https://id.example.com' },
      url: 'https://id.example.com/.well-known/openid-configuration',
      kind: 'openid-configuration',
      compatibility: 'mcp',
    });
    expect(load.mock.calls.map(([url]) => url)).toEqual([
      'https://id.example.com/.well-known/oauth-authorization-server',
      'https://id.example.com/.well-known/openid-configuration',
    ]);
  });

  it('rejects metadata for a different issuer and continues discovery', async () => {
    const load = vi
      .fn<(url: string) => Promise<{ issuer: string }>>()
      .mockResolvedValueOnce({ issuer: 'https://attacker.example' })
      .mockResolvedValueOnce({ issuer: 'https://id.example.com' });

    await expect(discoverIssuerMetadata('https://id.example.com', load)).resolves.toMatchObject({
      metadata: { issuer: 'https://id.example.com' },
      url: 'https://id.example.com/.well-known/openid-configuration',
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
