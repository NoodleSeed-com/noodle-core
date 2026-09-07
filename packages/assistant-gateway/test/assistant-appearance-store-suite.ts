import { expect, it } from 'vitest';
import type { AssistantAppearanceSettingsStore } from '../src/assistant-appearance-store.js';

/** One contract for process-local and durable appearance settings. */
export function describeAssistantAppearanceSettingsStore(
  makeStore: () => Promise<AssistantAppearanceSettingsStore>,
): void {
  const tenant = () => ({
    org: `org-${Math.random().toString(36).slice(2, 8)}`,
    app: 'site',
    env: 'prod',
  });
  const firstUpdate = new Date('2030-08-01T10:00:00.000Z');
  const secondUpdate = new Date('2030-08-01T11:00:00.000Z');

  it('starts at revision zero without manufacturing an override', async () => {
    const store = await makeStore();
    expect(await store.get(tenant())).toBeUndefined();
  });

  it('creates and fully replaces an override with optimistic revisions', async () => {
    const store = await makeStore();
    const target = tenant();
    const created = await store.replace({
      tenant: target,
      expectedRevision: 0,
      override: {
        branding: { accent: '#2563EB' },
        assistant: { theme: 'light', layout: { position: 'bottom-left' } },
      },
      updatedAt: firstUpdate,
      updatedBy: 'operator-1',
    });
    expect(created).toEqual({
      ok: true,
      record: {
        tenant: target,
        revision: 1,
        override: {
          branding: { accent: '#2563EB' },
          assistant: { theme: 'light', layout: { position: 'bottom-left' } },
        },
        updatedAt: firstUpdate,
        updatedBy: 'operator-1',
      },
    });

    const replaced = await store.replace({
      tenant: target,
      expectedRevision: 1,
      override: { assistant: { presentation: { launcher: { style: 'bubble' } } } },
      updatedAt: secondUpdate,
      updatedBy: 'operator-2',
    });
    expect(replaced).toMatchObject({
      ok: true,
      record: {
        revision: 2,
        override: { assistant: { presentation: { launcher: { style: 'bubble' } } } },
      },
    });
    if (!replaced.ok) throw new Error('expected replacement');
    expect(replaced.record.override).not.toHaveProperty('branding');
  });

  it('rejects stale writes without changing the winning record', async () => {
    const store = await makeStore();
    const target = tenant();
    await store.replace({
      tenant: target,
      expectedRevision: 0,
      override: { assistant: { theme: 'dark' } },
      updatedAt: firstUpdate,
      updatedBy: 'operator-1',
    });

    await expect(
      store.replace({
        tenant: target,
        expectedRevision: 0,
        override: { assistant: { theme: 'light' } },
        updatedAt: secondUpdate,
        updatedBy: 'stale-operator',
      }),
    ).resolves.toEqual({ ok: false, currentRevision: 1 });
    await expect(store.get(target)).resolves.toMatchObject({
      revision: 1,
      override: { assistant: { theme: 'dark' } },
      updatedBy: 'operator-1',
    });
  });

  it('records reset as a revision so a stale editor cannot resurrect old settings', async () => {
    const store = await makeStore();
    const target = tenant();
    await store.replace({
      tenant: target,
      expectedRevision: 0,
      override: { branding: { accent: '#2563EB' } },
      updatedAt: firstUpdate,
      updatedBy: 'operator-1',
    });
    const reset = await store.replace({
      tenant: target,
      expectedRevision: 1,
      override: undefined,
      updatedAt: secondUpdate,
      updatedBy: 'operator-2',
    });

    expect(reset).toEqual({
      ok: true,
      record: {
        tenant: target,
        revision: 2,
        updatedAt: secondUpdate,
        updatedBy: 'operator-2',
      },
    });
    await expect(
      store.replace({
        tenant: target,
        expectedRevision: 1,
        override: { branding: { accent: '#DC2626' } },
        updatedAt: secondUpdate,
        updatedBy: 'stale-operator',
      }),
    ).resolves.toEqual({ ok: false, currentRevision: 2 });
  });

  it('isolates tenant settings and returns defensive copies', async () => {
    const store = await makeStore();
    const first = tenant();
    const second = tenant();
    const override = { assistant: { suggestedPrompts: ['First'] } };
    const written = await store.replace({
      tenant: first,
      expectedRevision: 0,
      override,
      updatedAt: firstUpdate,
      updatedBy: 'operator-1',
    });
    expect(written.ok).toBe(true);
    expect(await store.get(second)).toBeUndefined();

    override.assistant.suggestedPrompts[0] = 'Mutated outside';
    const read = await store.get(first);
    expect(read?.override?.assistant?.suggestedPrompts).toEqual(['First']);
    if (read?.override?.assistant?.suggestedPrompts) {
      (read.override.assistant.suggestedPrompts as string[])[0] = 'Mutated read';
    }
    expect((await store.get(first))?.override?.assistant?.suggestedPrompts).toEqual(['First']);
  });
}
