import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { compile, compileManifest } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');

function read(rel: string): string {
  return readFileSync(join(fixtures, rel), 'utf8');
}

describe('compileManifest', () => {
  it('uses the same compiler path as YAML source compilation', () => {
    const source = read('valid/flow-basic.manifest.yaml');
    const fromYaml = compile(source);
    const fromObject = compileManifest(parseYaml(source));

    expect(fromObject).toEqual(fromYaml);
  });

  it('returns the same validation errors as YAML source compilation', () => {
    const source = `
manifestVersion: "1"
server:
  name: acme_support
  version: 1.0.0
  title: Title
tools:
  - name: repeated
    description: One
    inputSchema: {}
    fulfilment:
      output:
        id: \${input.id}
  - name: repeated
    description: Two
    inputSchema: {}
    fulfilment:
      use: bad-ref
`;
    const fromYaml = compile(source);
    const fromObject = compileManifest(parseYaml(source));

    expect(fromObject).toEqual(fromYaml);
    expect(fromObject.ok).toBe(false);
    if (fromObject.ok) return;
    expect(fromObject.errors.map((e) => e.code)).toEqual([
      'invalid_fulfilment',
      'duplicate_name',
      'invalid_operation_ref',
    ]);
  });
});
