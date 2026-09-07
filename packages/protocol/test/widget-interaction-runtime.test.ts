// @vitest-environment happy-dom
/// <reference lib="dom" />
import { beforeEach, describe, expect, it } from 'vitest';
import { WIDGET_BOOTSTRAP_SOURCE } from '../src/widget/bootstrap.js';
import { runWidgetRuntimeSource } from './widget-runtime-eval.js';

type Handler = (params: unknown) => unknown;

class InteractionHost {
  readonly handlers: Record<string, Handler | undefined> = {};
  readonly calls: Array<{ method: string; args: unknown }> = [];
  callResult: unknown = { structuredContent: { requestId: 'equipment_1' } };

  set ontoolresult(handler: Handler | undefined) {
    this.handlers.toolresult = handler;
  }
  set ontoolinput(handler: Handler | undefined) {
    this.handlers.toolinput = handler;
  }
  set ontoolcancelled(handler: Handler | undefined) {
    this.handlers.toolcancelled = handler;
  }
  set onhostcontextchanged(handler: Handler | undefined) {
    this.handlers.hostcontextchanged = handler;
  }
  set onteardown(handler: Handler | undefined) {
    this.handlers.teardown = handler;
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  getHostContext(): object {
    return {};
  }
  getHostCapabilities(): object {
    return { tools: true };
  }
  callServerTool(args: unknown): Promise<unknown> {
    this.calls.push({ method: 'callServerTool', args });
    return Promise.resolve(this.callResult);
  }
}

let host: InteractionHost;

function element<T extends Element>(selector: string): T {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`missing element ${selector}`);
  return found as T;
}

beforeEach(async () => {
  document.body.innerHTML = '<main><h1>Request equipment</h1></main>';
  const globals = globalThis as unknown as { ExtApps: unknown; __noodleInput?: unknown };
  globals.__noodleInput = undefined;
  globals.ExtApps = {
    App: class extends InteractionHost {
      constructor() {
        super();
        host = this;
      }
    },
    applyHostStyleVariables() {},
    applyHostFonts() {},
  };
  await runWidgetRuntimeSource(WIDGET_BOOTSTRAP_SOURCE);
});

describe('widget guided-input interaction', () => {
  it('renders business fields and resumes through metadata without technical JSON', async () => {
    host.handlers.toolinput?.({ arguments: { employeeId: 'person_1' } });
    host.handlers.toolresult?.({
      structuredContent: {
        code: 'interaction_unavailable',
        interaction: 'input',
        executed: false,
        recoverable: true,
        request: {
          id: 'equipment',
          message: 'Tell us what equipment you need.',
          requestedSchema: {
            type: 'object',
            properties: {
              equipmentType: {
                type: 'string',
                title: 'Equipment type',
                enum: ['laptop', 'monitor'],
              },
              businessReason: { type: 'string', title: 'Business reason' },
            },
            required: ['equipmentType', 'businessReason'],
          },
        },
      },
      _meta: { noodle: { interaction: { tool: 'order_equipment', responses: {} } } },
    });

    const card = element<HTMLElement>('#noodle-interaction-card');
    expect(card.textContent).toContain('Tell us what equipment you need.');
    expect(card.textContent).not.toContain('requestedSchema');
    element<HTMLSelectElement>('[name="equipmentType"]').value = 'laptop';
    element<HTMLInputElement>('[name="businessReason"]').value =
      'My current computer cannot run the design tools.';
    element<HTMLButtonElement>('#noodle-interaction-submit').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.calls[0]).toEqual({
      method: 'callServerTool',
      args: {
        name: 'order_equipment',
        arguments: { employeeId: 'person_1' },
        _meta: {
          noodle: {
            interaction: {
              responses: {
                equipment: {
                  action: 'accept',
                  content: {
                    equipmentType: 'laptop',
                    businessReason: 'My current computer cannot run the design tools.',
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(document.querySelector('#noodle-interaction-card')).toBeNull();
  });
});
