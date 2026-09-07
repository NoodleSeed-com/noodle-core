// @vitest-environment happy-dom
/// <reference lib="dom" />
import { beforeEach, describe, expect, it } from 'vitest';
import { WIDGET_BOOTSTRAP_SOURCE } from '../src/widget/bootstrap.js';

interface CallRecord {
  readonly method: string;
  readonly args: unknown;
}

class MockApp {
  calls: CallRecord[] = [];
  connected = false;
  widgetState: unknown = undefined;

  constructor() {
    captured = this;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  getHostCapabilities(): unknown {
    return { tools: true, openLink: true };
  }

  getWidgetState(): unknown {
    return this.widgetState;
  }

  setWidgetState(args: unknown): void {
    this.widgetState = args;
    this.calls.push({ method: 'setWidgetState', args });
  }
}

let captured: MockApp | undefined;

const runSource = Function('source', 'return (0,eval)(source)') as (source: string) => unknown;

beforeEach(() => {
  captured = undefined;
  document.documentElement.innerHTML = '<head></head><body></body>';
  const globals = globalThis as Record<string, unknown>;
  globals.ExtApps = { App: MockApp };
  globals.openai = undefined;
  delete globals.__noodleState;
  delete globals.__noodleData;
  delete globals.__noodleInput;
  delete globals.__noodleActiveView;
  delete globals.__noodleViewStack;
  delete globals.__noodleViewParams;
  delete globals.__noodleOverlayStack;
});

describe('widget runtime advanced flow', () => {
  it('navigates with typed params and blocks guarded transitions', async () => {
    const app = await install(`
      <div data-surface data-initial-view="list" data-state-defaults='{"selected_item_id":"item_1","allow":false}'>
        <section id="list" data-view="list">
          <button id="blocked" data-action="sequence" data-action-effects='[
            {"type":"navigate","view":"detail","params":{"item_id":"{{state.selected_item_id}}"},"guard":{"from":"state","path":"allow"}}
          ]'>Blocked</button>
          <button id="open" data-action="sequence" data-action-effects='[
            {"type":"setState","set":{"allow":true}},
            {"type":"navigate","view":"detail","params":{"item_id":"{{state.selected_item_id}}"}}
          ]'>Open</button>
        </section>
        <section id="detail" data-view="detail" data-view-params='{"item_id":"string"}' hidden>
          <span id="param" data-bind-params="item_id">-</span>
        </section>
      </div>
    `);
    expect(app.connected).toBe(true);

    el<HTMLButtonElement>('#blocked').click();
    await flush();
    expect(el<HTMLElement>('#list').hidden).toBe(false);
    expect(el<HTMLElement>('#detail').hidden).toBe(true);
    expect(el('[data-noodle-error]').textContent).toBe('Navigation blocked.');

    el<HTMLButtonElement>('#open').click();
    await flush();
    expect(el<HTMLElement>('#list').hidden).toBe(true);
    expect(el<HTMLElement>('#detail').hidden).toBe(false);
    expect(el('#param').textContent).toBe('item_1');
  });

  it('opens and closes overlay views without changing the base view', async () => {
    const app = await install(`
      <div data-surface data-initial-view="list" data-state-defaults='{"selected_item_id":"item_2"}'>
        <section id="list" data-view="list">
          <button id="open" data-action="sequence" data-action-effects='[
            {"type":"openOverlay","mode":"modal","view":"detail","params":{"item_id":"{{state.selected_item_id}}"}}
          ]'>Open</button>
        </section>
        <section id="detail" data-view="detail" data-overlay-mode="modal" data-view-params='{"item_id":"string"}' hidden>
          <span id="overlay-param" data-bind-params="item_id">-</span>
          <button id="close" data-action="sequence" data-action-effects='[
            {"type":"closeOverlay"}
          ]'>Close</button>
        </section>
      </div>
    `);

    el<HTMLButtonElement>('#open').click();
    await flush();
    expect(el<HTMLElement>('#list').hidden).toBe(false);
    expect(el<HTMLElement>('#detail').hidden).toBe(false);
    expect(el<HTMLElement>('#detail').getAttribute('data-overlay-active')).toBe('true');
    expect(el('#overlay-param').textContent).toBe('item_2');
    expect(app.calls.some((call) => call.method === 'setWidgetState')).toBe(true);

    el<HTMLButtonElement>('#close').click();
    await flush();
    expect(el<HTMLElement>('#list').hidden).toBe(false);
    expect(el<HTMLElement>('#detail').hidden).toBe(true);
  });

  it('back closes the top overlay before popping base views', async () => {
    await install(`
      <div data-surface data-initial-view="list">
        <section id="list" data-view="list">
          <button id="open" data-action="sequence" data-action-effects='[
            {"type":"openOverlay","mode":"sheet","view":"cart"}
          ]'>Open cart</button>
        </section>
        <section id="cart" data-view="cart" data-overlay-mode="sheet" hidden>
          <button id="back" data-action="sequence" data-action-effects='[
            {"type":"back"}
          ]'>Back</button>
        </section>
      </div>
    `);

    el<HTMLButtonElement>('#open').click();
    await flush();
    expect(el<HTMLElement>('#cart').hidden).toBe(false);

    el<HTMLButtonElement>('#back').click();
    await flush();
    expect(el<HTMLElement>('#list').hidden).toBe(false);
    expect(el<HTMLElement>('#cart').hidden).toBe(true);
  });
});

async function install(html: string): Promise<MockApp> {
  document.body.innerHTML = html;
  runSource(WIDGET_BOOTSTRAP_SOURCE);
  await flush();
  if (!captured) throw new Error('mock app was not captured');
  return captured;
}

function el<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`missing element ${selector}`);
  return found as T;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
