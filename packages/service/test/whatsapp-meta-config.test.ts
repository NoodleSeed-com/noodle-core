import { describe, expect, it } from 'vitest';
import { resolveWhatsAppMetaConfig } from '../src/channels/meta-config.js';

const complete = {
  NOODLE_WHATSAPP_META_APP_ID: '931692592882983',
  NOODLE_WHATSAPP_META_APP_SECRET: 'a'.repeat(32),
  NOODLE_WHATSAPP_META_VERIFY_TOKEN: 'b'.repeat(32),
};
describe('Meta WhatsApp platform configuration', () => {
  it('is absent when none of the variables are set', () => {
    expect(resolveWhatsAppMetaConfig({})).toBeUndefined();
  });
  it('reads a complete configuration and pins the Graph API version by default', () => {
    expect(resolveWhatsAppMetaConfig(complete)).toEqual({
      appId: '931692592882983',
      appSecret: 'a'.repeat(32),
      verifyToken: 'b'.repeat(32),
      graphVersion: 'v25.0',
    });
    expect(
      resolveWhatsAppMetaConfig({ ...complete, NOODLE_WHATSAPP_META_GRAPH_VERSION: 'v26.0' })
        ?.graphVersion,
    ).toBe('v26.0');
  });
  it.each([
    ['a partial set', { NOODLE_WHATSAPP_META_APP_ID: complete.NOODLE_WHATSAPP_META_APP_ID }],
    ['a non-numeric app id', { ...complete, NOODLE_WHATSAPP_META_APP_ID: 'noodle' }],
    ['a short app secret', { ...complete, NOODLE_WHATSAPP_META_APP_SECRET: 'short' }],
    ['a short verify token', { ...complete, NOODLE_WHATSAPP_META_VERIFY_TOKEN: 'short' }],
    [
      'a verify token equal to the app secret',
      { ...complete, NOODLE_WHATSAPP_META_VERIFY_TOKEN: complete.NOODLE_WHATSAPP_META_APP_SECRET },
    ],
    ['an unpinned Graph version', { ...complete, NOODLE_WHATSAPP_META_GRAPH_VERSION: 'latest' }],
    ['a version without the rest', { NOODLE_WHATSAPP_META_GRAPH_VERSION: 'v25.0' }],
  ])('refuses %s without echoing any value', (_name, env) => {
    let message = '';
    try {
      resolveWhatsAppMetaConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/NOODLE_WHATSAPP_META_/);
    expect(message).not.toContain('a'.repeat(32));
    expect(message).not.toContain('b'.repeat(32));
  });
});
