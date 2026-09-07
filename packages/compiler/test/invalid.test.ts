import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import type { CompileErrorCode } from '../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures', 'invalid');

const cases: ReadonlyArray<{ file: string; code: CompileErrorCode; path: string }> = [
  { file: 'missing-tools.yaml', code: 'invalid_shape', path: 'tools' },
  { file: 'bad-name-uppercase.yaml', code: 'invalid_name', path: 'tools.0.name' },
  { file: 'duplicate-tool-name.yaml', code: 'duplicate_name', path: 'tools.1.name' },
  {
    file: 'external-ref.yaml',
    code: 'external_ref',
    path: 'tools.0.inputSchema.properties.order.$ref',
  },
  {
    file: 'unknown-manifest-version.yaml',
    code: 'unsupported_manifest_version',
    path: 'manifestVersion',
  },
  {
    file: 'agent-guide-workflow-id-too-long.yaml',
    code: 'agent_guide_invalid',
    path: 'server.agentGuide.workflows.0.id',
  },
  {
    file: 'continuity-on-authenticated-surface.yaml',
    code: 'invalid_shape',
    path: 'server.assistant.surfaces.0.continuity',
  },
  // Expression + flow-fulfilment errors (catalog-independent):
  { file: 'expr-bad-syntax.yaml', code: 'invalid_expression', path: 'tools.0.fulfilment.args.id' },
  { file: 'expr-empty.yaml', code: 'invalid_expression', path: 'tools.0.fulfilment.args.id' },
  { file: 'expr-unknown-root.yaml', code: 'expr_unknown_root', path: 'tools.0.fulfilment.args.id' },
  {
    file: 'expr-deferred-root.yaml',
    code: 'expr_root_unavailable',
    path: 'tools.0.fulfilment.args.id',
  },
  {
    file: 'expr-operator-in-args.yaml',
    code: 'expr_operator_not_allowed',
    path: 'tools.0.fulfilment.args.id',
  },
  {
    file: 'flow-if-not-boolean.yaml',
    code: 'expr_if_not_boolean',
    path: 'tools.0.fulfilment.steps.0.if',
  },
  {
    file: 'flow-unknown-step.yaml',
    code: 'unknown_step_ref',
    path: 'tools.0.fulfilment.steps.0.args.id',
  },
  {
    file: 'flow-forward-step.yaml',
    code: 'forward_step_ref',
    path: 'tools.0.fulfilment.steps.0.args.id',
  },
  {
    file: 'flow-self-step.yaml',
    code: 'self_step_ref',
    path: 'tools.0.fulfilment.steps.0.args.id',
  },
  {
    file: 'flow-dup-step-id.yaml',
    code: 'duplicate_step_id',
    path: 'tools.0.fulfilment.steps.1.id',
  },
  {
    file: 'flow-missing-output.yaml',
    code: 'invalid_fulfilment',
    path: 'tools.0.fulfilment.output',
  },
  { file: 'fulfilment-both.yaml', code: 'invalid_fulfilment', path: 'tools.0.fulfilment' },
  { file: 'step-no-verb.yaml', code: 'invalid_fulfilment', path: 'tools.0.fulfilment.steps.0' },
];

describe('compile (invalid manifests)', () => {
  for (const testCase of cases) {
    it(`${testCase.file} -> ${testCase.code} at "${testCase.path}"`, () => {
      const result = compile(readFileSync(join(fixtures, testCase.file), 'utf8'));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: testCase.code, path: testCase.path }),
      );
    });
  }
});
