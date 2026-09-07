import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY_SALT, deriveHostedAsset, scopePrefix, sha256Hex } from '../src/index.js';

describe('hosted asset identity', () => {
  it('derives a deterministic scope-blinded content-addressed key and public URL', () => {
    const asset = deriveHostedAsset(
      DEFAULT_KEY_SALT,
      { org: 'acme', app: 'inventory', env: 'prod' },
      {
        logicalId: 'logo',
        sourcePath: 'assets/logo.png',
        contentHash: 'sha256:abc123',
        mimeType: 'image/png',
        byteLength: 42,
        width: 16,
        height: 16,
      },
      'https://assets.example.test/',
    );

    expect(scopePrefix(DEFAULT_KEY_SALT, { org: 'acme', app: 'inventory', env: 'prod' })).toBe(
      '9dda43a7cc3bcb6f/f1bc7ae930869972/6e53be889e8b5ae3/',
    );
    expect(asset).toEqual({
      logicalId: 'logo',
      sourcePath: 'assets/logo.png',
      contentHash: 'sha256:abc123',
      mimeType: 'image/png',
      byteLength: 42,
      width: 16,
      height: 16,
      objectKey: '9dda43a7cc3bcb6f/f1bc7ae930869972/6e53be889e8b5ae3/abc123/logo',
      publicUrl:
        'https://assets.example.test/9dda43a7cc3bcb6f/f1bc7ae930869972/6e53be889e8b5ae3/abc123/logo',
    });
  });

  it('normalizes only a sha256 prefix from content hashes', () => {
    expect(sha256Hex('sha256:abc123')).toBe('abc123');
    expect(sha256Hex('abc123')).toBe('abc123');
  });
});
