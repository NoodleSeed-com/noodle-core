import { describe, expect, it } from 'vitest';
import { helloFiles, httpApiFiles } from '../src/project-scaffold-templates.js';
import { widgetFiles } from '../src/widget-scaffold-template.js';

const saasFiles = (name: string, agents: []) => widgetFiles(name, agents, 'saas');

describe('generated scaffold contracts', () => {
  it.each([
    ['hello', helloFiles],
    ['http-api', httpApiFiles],
    ['widget', widgetFiles],
    ['saas', saasFiles],
  ] as const)('%s ships registration, useful result and invalid-input evidence', (_name, render) => {
    const files = render('customer-project', []);
    const test = files['test/server.test.ts'] ?? '';
    expect(test).toContain("'tools', 'list'");
    expect(test).toContain("'tools', 'call'");
    expect(test).toContain('structuredContent');
    expect(test).toContain('invalid input');
    expect(test).toContain('mkdtempSync');
    expect(test).not.toContain('toManifest');
    expect(files['package.json']).toContain('vitest run --dir test');
    expect(files['package.json']).toContain('vitest run --dir test && noodle validate --json');
  });

  it('makes SaaS embedded-first without inventing a customer IdP', () => {
    const files = saasFiles('embedded-saas', []);
    const server = files['src/server.ts'] ?? '';
    expect(server).toContain('embeddedAssistant({');
    expect(server).toContain('model: noodleManaged()');
    expect(server).toContain('authenticatedWebsite({');
    expect(server).toContain("variable('ASSISTANT_ORIGIN')");
    expect(server).toContain('contextProvider: true');
    expect(server).not.toMatch(/federatedOidc|id\.your-app|openAICompatible|process\.env/);
    expect(files['README.md']).toContain('authenticateAssistantRequest');
    expect(files['README.md']).toContain('noodle assistant embed');
    expect(files['README.md']).not.toContain('Optional embedded assistant');
    expect(files['.env.example']).toContain('ASSISTANT_ORIGIN=');
    expect(files['test/server.test.ts']).toContain('ASSISTANT_ORIGIN');
  });

  it('retains explicit credential-free widgets and honest synthetic actions', () => {
    const files = widgetFiles('portable-widget', []);
    expect(files['src/server.ts']).not.toMatch(/embeddedAssistant|customerAuth/);
    expect(files['README.md']).toContain('Optional embedded assistant');
    expect(files['src/server.ts']).toContain('demo: z.literal(true)');
    expect(files['src/server.ts']).toContain('not saved');
    expect(files['src/views/preferences-card.tsx']).toContain('Preview preference');
    expect(files['src/views/preferences-card.tsx']).toContain(
      'isPreferences(result.structuredContent)',
    );
    expect(files['src/views/preferences-card.tsx']).toContain('inFlight.current');
  });

  it('proves the HTTP connector against an isolated local fixture, never a third-party demo API', () => {
    const files = httpApiFiles('my-api', []);
    expect(files['src/server.ts']).not.toContain('jsonplaceholder');
    expect(files['src/server.ts']).toContain("variable('POSTS_API_ORIGIN')");
    expect(files['test/server.test.ts']).toContain('createServer');
    expect(files['test/server.test.ts']).toContain('127.0.0.1');
    expect(files['test/server.test.ts']).toContain('requests');
  });
});
