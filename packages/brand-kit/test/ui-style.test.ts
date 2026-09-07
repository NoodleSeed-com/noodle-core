import { describe, expect, it } from 'vitest';
import { widgetRuntimeConfigHtml } from '../src/index.js';

describe('server brand kit widget delivery', () => {
  it('delivers themed brand assets to widget runtime code', () => {
    const html = widgetRuntimeConfigHtml({
      branding: {
        name: 'Acme',
        logo: {
          uri: 'https://assets.example/logo.svg',
          darkUri: 'https://assets.example/logo-dark.svg',
          alt: 'Acme',
        },
      },
    });
    expect(html).toContain('data-noodle-policy');
    expect(html).toContain('logo-dark.svg');
  });
});
