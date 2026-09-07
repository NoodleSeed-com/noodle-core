import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import { assistantViewAvailableData } from '../src/assistant-view-availability.js';

const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

function artifact(overrides: { resourceUri?: string; resources?: unknown[] }): RuntimeArtifact {
  return {
    server: { name: 'test', version: '1.0.0' },
    tools: [
      {
        name: 'lookup',
        ...(overrides.resourceUri === undefined
          ? {}
          : { _meta: { ui: { resourceUri: overrides.resourceUri } } }),
      },
    ],
    ...(overrides.resources === undefined ? {} : { resources: overrides.resources }),
  } as unknown as RuntimeArtifact;
}

function widgetResource(uri: string): unknown {
  return {
    uri,
    mimeType: MCP_APP_MIME_TYPE,
    title: 'Account',
    fulfilment: { kind: 'flow', output: { value: { kind: 'literal', value: '<main>ok</main>' } } },
  };
}

describe('assistantViewAvailableData', () => {
  it('resolves a linked widget resource without reporting a failure', () => {
    const onUnresolved = vi.fn();
    const view = assistantViewAvailableData(
      artifact({ resourceUri: 'ui://app/card', resources: [widgetResource('ui://app/card')] }),
      { id: 'call-1', tool: 'lookup', result: { status: 'ready' } },
      onUnresolved,
    );
    expect(view?.resourceUri).toBe('ui://app/card');
    expect(onUnresolved).not.toHaveBeenCalled();
  });

  it('stays silent for a tool that declares no widget', () => {
    const onUnresolved = vi.fn();
    const view = assistantViewAvailableData(
      artifact({}),
      { id: 'call-1', tool: 'lookup', result: {} },
      onUnresolved,
    );
    expect(view).toBeUndefined();
    expect(onUnresolved).not.toHaveBeenCalled();
  });

  it('reports a declared widget whose resource is missing instead of failing silently', () => {
    const onUnresolved = vi.fn();
    const view = assistantViewAvailableData(
      artifact({ resourceUri: 'ui://app/card', resources: [] }),
      { id: 'call-1', tool: 'lookup', result: {} },
      onUnresolved,
    );
    expect(view).toBeUndefined();
    expect(onUnresolved).toHaveBeenCalledWith({
      tool: 'lookup',
      resourceUri: 'ui://app/card',
      reason: 'resource_not_found',
    });
  });

  it('reports a widget resource whose body is not a renderable literal', () => {
    const onUnresolved = vi.fn();
    const broken = {
      uri: 'ui://app/card',
      mimeType: MCP_APP_MIME_TYPE,
      fulfilment: { kind: 'flow', output: { value: { kind: 'expression', value: '${x}' } } },
    };
    const view = assistantViewAvailableData(
      artifact({ resourceUri: 'ui://app/card', resources: [broken] }),
      { id: 'call-1', tool: 'lookup', result: {} },
      onUnresolved,
    );
    expect(view).toBeUndefined();
    expect(onUnresolved).toHaveBeenCalledWith({
      tool: 'lookup',
      resourceUri: 'ui://app/card',
      reason: 'resource_not_renderable',
    });
  });
});
