import { describe, expect, it } from 'vitest';
import { localBootError, localMcpError } from '../src/commands/local-readiness.js';
import type { DevReloadResult } from '../src/dev.js';
import type { EffectiveLocalTargetResolution } from '../src/local-target.js';

const LINKED_TARGET: EffectiveLocalTargetResolution = {
  target: { org: 'noodleseed', app: 'site-assistant', env: 'prod' },
  mode: 'linked',
  sources: { org: 'link', app: 'link', env: 'link' },
  ignoredSavedTarget: false,
};

describe('local boot recovery', () => {
  it.each([
    undefined,
    [{ code: 'read_error', path: 'private-path', message: 'private credential text' }],
  ])('reports a failed boot before issuing an MCP request, even without config errors', (errors) => {
    const error = localBootError(
      { ok: false, ...(errors ? { errors } : {}) },
      LINKED_TARGET,
      '/tmp/Existing app',
    );
    expect(error).toMatchObject({
      code: 'local_boot_failed',
      next: "cd '/tmp/Existing app' && noodle validate --json",
    });
    expect(JSON.stringify(error)).not.toContain('private');
  });

  it('does not classify a successful boot as a failure', () => {
    expect(localBootError({ ok: true }, LINKED_TARGET)).toBeUndefined();
  });

  it('reports all missing variables and secrets together with value-free exact-target recovery', () => {
    const error = localBootError(
      {
        ok: false,
        errors: [
          {
            code: 'missing_variable',
            path: 'variables.API_ORIGIN',
            message: 'private text must not appear',
          },
          {
            code: 'missing_secret',
            path: 'secrets.API_TOKEN',
            message: 'private text must not appear',
          },
          { code: 'missing_variable', path: 'variables.API_ORIGIN', message: 'duplicate' },
        ],
      },
      LINKED_TARGET,
      '/tmp/Existing app',
    );
    expect(error).toMatchObject({
      code: 'connector_secret_unresolved',
      detail: { target: LINKED_TARGET.target, secrets: ['API_TOKEN'], variables: ['API_ORIGIN'] },
    });
    expect(error?.fix).toContain('noodle variables set API_ORIGIN');
    expect(error?.fix).toContain('noodle secrets set API_TOKEN');
    expect(error?.fix).toContain("cd '/tmp/Existing app'");
    expect(JSON.stringify(error)).not.toContain('private text');
  });

  it('anchors managed-config recovery commands in the containing project directory', () => {
    const boot: DevReloadResult = {
      ok: false,
      errors: [
        {
          code: 'missing_secret',
          path: 'secrets.ASSISTANT_MODEL_API_KEY',
          message: 'missing',
        },
        {
          code: 'missing_secret',
          path: 'secrets.LEAD_SINK_TOKEN',
          message: 'missing',
        },
      ],
    };

    const error = localBootError(boot, LINKED_TARGET, '/tmp/Noodle app');

    expect(error?.fix).toBe(
      "cd '/tmp/Noodle app' && noodle secrets set ASSISTANT_MODEL_API_KEY --runtime local --scope env --org noodleseed --app site-assistant --env prod --from-env ASSISTANT_MODEL_API_KEY && noodle secrets set LEAD_SINK_TOKEN --runtime local --scope env --org noodleseed --app site-assistant --env prod --from-env LEAD_SINK_TOKEN",
    );
  });
});

describe('local MCP completion classification', () => {
  it.each([
    [503, { result: { content: [] } }, 'rpc_error'],
    [200, { error: { code: -32602, message: 'private', data: 'private' } }, 'rpc_error'],
    [200, undefined, 'invalid_result'],
    [200, { result: null }, 'invalid_result'],
    [200, { result: {} }, 'invalid_result'],
    [
      200,
      { result: { content: [], isError: true, structuredContent: { token: 'private' } } },
      'tool_error',
    ],
    [200, { result: { resultType: 'input_required', requestState: 'private' } }, 'input_required'],
    [200, { result: { resultType: 'task', task: { id: 'private' } } }, 'incomplete_result'],
  ] as const)('rejects incomplete evidence (%s, %j) without payload disclosure', (status, body, reason) => {
    const error = localMcpError({ status, body }, 'tools/call');
    expect(error).toMatchObject({ detail: { reason, status } });
    expect(JSON.stringify(error)).not.toContain('private');
    expect(JSON.stringify(error)).not.toContain('requestState');
  });

  it('accepts legacy and modern complete results, including intentionally empty content', () => {
    for (const result of [
      { content: [] },
      { resultType: 'complete', content: [], isError: false },
    ]) {
      expect(localMcpError({ status: 200, body: { result } }, 'tools/call')).toBeUndefined();
    }
  });

  it('does not mistake missing method-specific results for a successful response', () => {
    for (const method of ['initialize', 'tools/list', 'resources/read', 'prompts/get'] as const) {
      expect(localMcpError({ status: 200, body: { result: {} } }, method)).toMatchObject({
        detail: { reason: 'invalid_result' },
      });
    }
    expect(
      localMcpError({ status: 200, body: { result: { tools: [null] } } }, 'tools/list'),
    ).toBeDefined();
  });

  it('checks the declared schema without leaking validation values or changing caller data', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    };
    const response = {
      status: 200,
      body: { result: { content: [], structuredContent: { count: 'private' } } },
    };
    expect(localMcpError(response, 'tools/call', schema)).toMatchObject({
      detail: { reason: 'output_schema_mismatch' },
    });
    expect(JSON.stringify(localMcpError(response, 'tools/call', schema))).not.toContain('private');
    expect(response.body.result.structuredContent.count).toBe('private');
  });
});
