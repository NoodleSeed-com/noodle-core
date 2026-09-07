import { describe, expect, it } from 'vitest';
import { protectedResourceMetadata, protectedResourceMetadataUrl } from '../src/index.js';

describe('protectedResourceMetadataUrl', () => {
  it('inserts the well-known prefix before the resource path', () => {
    expect(protectedResourceMetadataUrl('https://borg.test/o/acme/support/mcp')).toBe(
      'https://borg.test/.well-known/oauth-protected-resource/o/acme/support/mcp',
    );
  });

  it('accepts a URL instance', () => {
    expect(protectedResourceMetadataUrl(new URL('https://borg.test/o/a/b/dev/mcp'))).toBe(
      'https://borg.test/.well-known/oauth-protected-resource/o/a/b/dev/mcp',
    );
  });
});

describe('protectedResourceMetadata', () => {
  it('advertises the resource and its authorization server', () => {
    const doc = protectedResourceMetadata({
      resource: 'https://borg.test/o/acme/support/mcp',
      authorizationServers: ['https://as.noodle.test'],
      scopesSupported: ['tickets.read', 'tickets.write'],
    });
    expect(doc.resource).toBe('https://borg.test/o/acme/support/mcp');
    expect(doc.authorization_servers).toEqual(['https://as.noodle.test']);
    expect(doc.scopes_supported).toEqual(['tickets.read', 'tickets.write']);
    expect(doc.bearer_methods_supported).toEqual(['header']);
  });

  it('omits authorization_servers when none are configured', () => {
    const doc = protectedResourceMetadata({ resource: 'https://borg.test/o/a/b/mcp' });
    expect(doc.authorization_servers).toBeUndefined();
  });
});
