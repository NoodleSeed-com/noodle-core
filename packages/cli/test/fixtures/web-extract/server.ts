import { noodleManaged, server, webExtract } from '@noodleseed/one';

export default server('web_capability_validation', {
  title: 'Staging web capability validation',
  version: '1.0.0',
  capabilities: [webExtract('pages', {
    title: 'Read Noodle Seed pages',
    description: 'Read an explicitly selected public Noodle Seed page as untrusted source evidence.',
    provider: noodleManaged(),
    policy: { domains: ['noodleseed.com'], maxUrls: 1, maxCalls: 2, timeoutMs: 15_000, maxTextBytes: 8192 },
  })],
}, []);
