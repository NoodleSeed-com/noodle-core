import { describe, expect, it } from 'vitest';
import { consoleSignedOutReturnUrl } from '../src/oauth/console-url.js';

describe('Console fixed return URLs', () => {
  it('derives the passive signed-out page from the configured OAuth callback', () => {
    expect(
      consoleSignedOutReturnUrl(
        'https://console.example.test/api/console/auth/callback?ignored=true#fragment',
      ),
    ).toBe('https://console.example.test/signed-out');
  });

  it('preserves a loopback Console origin while replacing its callback path', () => {
    expect(consoleSignedOutReturnUrl('http://127.0.0.1:3000/api/console/auth/callback')).toBe(
      'http://127.0.0.1:3000/signed-out',
    );
  });
});
