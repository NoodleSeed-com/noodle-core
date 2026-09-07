import { compileManifest } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { asset, type DistributionMetadataSource, server, tool, z } from '../src/index.js';

const distribution = {
  listing: {
    summary: 'Plan and complete team work with Acme Tasks.',
    description:
      'Acme Tasks helps teams review, prioritize, capture, and complete shared work from an agent.',
    keywords: ['tasks', 'productivity'],
  },
  publisher: {
    name: 'Acme, Inc.',
    websiteUrl: 'https://acme.example',
  },
  support: {
    documentationUrl: 'https://docs.acme.example/tasks',
    supportUrl: 'https://support.acme.example/tasks',
  },
  legal: {
    privacyPolicyUrl: 'https://acme.example/privacy',
    termsOfServiceUrl: 'https://acme.example/terms',
  },
  assets: {
    icon: { source: asset('./assets/icon.png'), alt: 'Acme Tasks icon' },
    screenshots: [{ source: asset('./assets/task-list.png'), alt: 'Prioritized Acme task list' }],
  },
  review: {
    instructions: 'Use the seeded reviewer workspace. Credentials are supplied out of band.',
    scenarios: [
      {
        id: 'review_tasks',
        prompt: 'Show my tasks for today.',
        expected: 'The current task list is returned without changing it.',
        shouldInvoke: true,
        tools: ['list_work'],
      },
      {
        id: 'unrelated_weather',
        prompt: 'Will it rain tomorrow?',
        expected: 'Acme Tasks is not invoked.',
        shouldInvoke: false,
      },
    ],
  },
} as const satisfies DistributionMetadataSource;

function guidedServer(options: { readonly distribution?: DistributionMetadataSource } = {}) {
  return server(
    'distribution_fixture',
    {
      title: 'Distribution Fixture',
      version: '1.0.0',
      agentGuide: {
        description: 'Use the distribution fixture to inspect work.',
        useWhen: ['The user asks to inspect fixture work.'],
        workflows: [
          {
            id: 'inspect_work',
            title: 'Inspect work',
            steps: [{ capability: { kind: 'tool', name: 'list_work' } }],
          },
        ],
      },
      ...options,
    },
    [
      tool('list_work', {
        description: 'List current fixture work.',
        input: z.object({}),
        fulfil: () => ({ work: [] }),
      }),
    ],
  );
}

describe('host distribution authoring', () => {
  it('returns a versioned defensive distribution projection from the server definition', () => {
    const app = guidedServer({ distribution });
    const projected = app.toDistributionMetadata();

    expect(projected).toEqual({ schemaVersion: 1, ...distribution });
    expect(projected).not.toBe(distribution);
    expect(projected?.listing).not.toBe(distribution.listing);
    expect(projected?.assets.icon.source).not.toBe(distribution.assets.icon.source);
    expect(projected?.assets.screenshots?.[0]).toEqual({
      source: distribution.assets.screenshots[0].source,
      alt: 'Prioritized Acme task list',
    });
    expect(projected?.review.scenarios).not.toBe(distribution.review.scenarios);
    expect(projected?.review.scenarios[0]?.tools).toEqual(['list_work']);
  });

  it('preserves an optional screenshot prompt for host review evidence', () => {
    const screenshot = distribution.assets.screenshots[0];
    const app = guidedServer({
      distribution: {
        ...distribution,
        assets: {
          ...distribution.assets,
          screenshots: [
            {
              ...screenshot,
              prompt: 'Show my prioritized Acme task list.',
            },
          ],
        },
      },
    });

    expect(app.toDistributionMetadata()?.assets.screenshots?.[0]).toMatchObject({
      alt: 'Prioritized Acme task list',
      prompt: 'Show my prioritized Acme task list.',
    });
  });

  it('omits distribution metadata when the app does not opt into host packaging', () => {
    expect(guidedServer().toDistributionMetadata()).toBeUndefined();
  });

  it('keeps distribution metadata out of the manifest, Runtime Artifact, and App Package identity', async () => {
    const plainManifest = await guidedServer().toManifest();
    const distributedManifest = await guidedServer({ distribution }).toManifest();

    expect(distributedManifest).toEqual(plainManifest);
    expect(JSON.stringify(distributedManifest)).not.toContain('privacyPolicyUrl');

    const plain = compileManifest(plainManifest);
    const distributed = compileManifest(distributedManifest);
    expect(plain.ok && distributed.ok).toBe(true);
    if (!plain.ok || !distributed.ok) return;
    expect(distributed.artifact).toEqual(plain.artifact);
    expect(distributed.appPackage).toEqual(plain.appPackage);
  });
});
