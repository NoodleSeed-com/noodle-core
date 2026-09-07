import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DesignSessionV1 } from '../src/devtools-design-contract.js';
import {
  createDesignStore,
  DesignStoreConflictError,
  DesignStoreCorruptError,
} from '../src/devtools-design-store.js';

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'noodle-design-store-'));
  roots.push(root);
  return root;
}

function draft(overrides: Partial<DesignSessionV1> = {}): DesignSessionV1 {
  return {
    version: 1,
    id: 'd4fe7335-69c4-4906-a736-73ab30af864a',
    status: 'draft',
    project: {
      entrypoint: 'src/server.ts',
      toolName: 'open_ordering',
    },
    viewport: {
      width: 1280,
      height: 800,
      device: 'desktop',
      theme: 'dark',
    },
    createdAt: '2026-07-29T12:00:00.000Z',
    updatedAt: '2026-07-29T12:00:00.000Z',
    annotations: [
      {
        id: '8f360fe7-8c9e-4474-bebd-84c49ccab760',
        target: {
          tagName: 'button',
          role: 'button',
          accessibleName: 'Continue to checkout',
          visibleText: 'Continue to checkout',
          stableId: 'checkout-button',
          classNames: ['checkout', 'primary'],
          authorHints: {
            component: 'CheckoutButton',
          },
          ancestry: [
            {
              tagName: 'section',
              role: 'region',
              classNames: ['checkout-card'],
              nthOfType: 1,
            },
          ],
          siblingIndex: 1,
          siblingCount: 3,
          rect: { x: 400, y: 300, width: 220, height: 48 },
          computedStyles: {
            'background-color': 'rgb(0, 0, 0)',
            color: 'rgb(255, 255, 255)',
            'padding-top': '12px',
          },
          resolution: {
            confidence: 0.95,
            evidence: ['stable id', 'component hint'],
            status: 'resolved',
          },
        },
        intent: 'Make the primary action warmer and easier to spot.',
        changes: [
          {
            property: 'background-color',
            from: 'rgb(0, 0, 0)',
            to: '#ff6b35',
          },
        ],
        acceptanceCriteria: ['The primary action remains readable.'],
        preserve: ['Button behavior and accessible name.'],
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('createDesignStore', () => {
  it('returns no sessions before design work begins', () => {
    const store = createDesignStore(projectRoot());

    expect(store.readDraft()).toBeUndefined();
    expect(store.readLatest()).toBeUndefined();
  });

  it('atomically writes a private draft and reads it back', () => {
    const root = projectRoot();
    const store = createDesignStore(root);
    const session = draft();

    store.writeDraft(session);

    expect(store.readDraft()).toEqual(session);
    const designDirectory = join(root, '.noodle', 'design');
    expect(statSync(designDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(designDirectory, 'draft.json')).mode & 0o777).toBe(0o600);
    expect(
      readdirSync(designDirectory).filter(
        (name) => name.startsWith('draft.json.') && name.endsWith('.tmp'),
      ),
    ).toEqual([]);
  });

  it('rejects stale updates and returns the current draft', () => {
    const root = projectRoot();
    const store = createDesignStore(root);
    const initial = draft();
    const current = draft({
      updatedAt: '2026-07-29T12:01:00.000Z',
    });

    store.writeDraft(initial);
    store.writeDraft(current, initial.updatedAt);

    try {
      store.writeDraft(draft({ updatedAt: '2026-07-29T12:02:00.000Z' }), initial.updatedAt);
      throw new Error('expected a design store conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(DesignStoreConflictError);
      expect((error as DesignStoreConflictError).current).toEqual(current);
    }
  });

  it('finalizes an immutable snapshot and updates latest', () => {
    const root = projectRoot();
    const store = createDesignStore(root);
    const session = draft();
    store.writeDraft(session);

    const ready = store.finalize(session);
    const snapshotPath = join(root, '.noodle', 'design', 'sessions', `${ready.id}.json`);

    expect(ready.status).toBe('ready');
    expect(ready.id).not.toBe(session.id);
    expect(store.readLatest()).toEqual(ready);
    expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toEqual(ready);
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
    expect(store.readDraft()).toEqual(session);
  });

  it('refuses to finalize a draft with no meaningful annotation', () => {
    const store = createDesignStore(projectRoot());
    const [annotation] = draft().annotations;
    if (annotation === undefined) throw new Error('fixture annotation is required');
    const session = draft({
      annotations: [
        {
          ...annotation,
          intent: '  ',
          changes: [],
        },
      ],
    });

    expect(() => store.finalize(session)).toThrow(/meaningful annotation/i);
  });

  it('throws for corrupt and unsupported persisted drafts', () => {
    const root = projectRoot();
    const designDir = join(root, '.noodle', 'design');
    mkdirSync(designDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(designDir, 'draft.json'), '{not-json', { mode: 0o600 });

    expect(() => createDesignStore(root).readDraft()).toThrow(DesignStoreCorruptError);

    writeFileSync(join(designDir, 'draft.json'), JSON.stringify({ ...draft(), version: 2 }));
    expect(() => createDesignStore(root).readDraft()).toThrow(DesignStoreCorruptError);
  });

  it('rejects unsafe latest pointers', () => {
    const root = projectRoot();
    const designDir = join(root, '.noodle', 'design');
    mkdirSync(designDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(designDir, 'latest.json'),
      JSON.stringify({
        version: 1,
        id: '../../outside',
        updatedAt: '2026-07-29T12:00:00.000Z',
      }),
      { mode: 0o600 },
    );

    expect(() => createDesignStore(root).readLatest()).toThrow(DesignStoreCorruptError);
  });

  it('preserves a valid draft when a replacement is invalid', () => {
    const root = projectRoot();
    const store = createDesignStore(root);
    const valid = draft();
    store.writeDraft(valid);

    const invalid = {
      ...draft({ updatedAt: '2026-07-29T12:02:00.000Z' }),
      unexpected: 'not allowed',
    } as unknown as DesignSessionV1;

    expect(() => store.writeDraft(invalid, valid.updatedAt)).toThrow();
    expect(store.readDraft()).toEqual(valid);
  });

  it('does not weaken an existing private directory mode', () => {
    const root = projectRoot();
    const designDir = join(root, '.noodle', 'design');
    mkdirSync(designDir, { recursive: true, mode: 0o700 });
    chmodSync(designDir, 0o700);

    createDesignStore(root).writeDraft(draft());

    expect(statSync(designDir).mode & 0o777).toBe(0o700);
  });
});
