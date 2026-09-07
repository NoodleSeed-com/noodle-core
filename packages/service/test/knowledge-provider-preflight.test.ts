import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import {
  artifactSecretBindings,
  artifactVariableBindings,
  missingServerConfigErrors,
} from '../src/assistant-bindings.js';

/**
 * BYO knowledge provider config (ADR 0202 amendment 2026-08-18) travels by NAME in the compiled
 * artifact and joins the existing missing-config deploy preflight: an unset secret/variable fails
 * the deploy closed before anything crawls.
 */

function artifactWith(knowledge: unknown): RuntimeArtifact {
  return {
    server: { name: 'app', knowledge },
  } as unknown as RuntimeArtifact;
}

const byoComponent = {
  name: 'product',
  crawler: {
    provider: 'firecrawl',
    config: { apiKey: { kind: 'secret', name: 'FIRECRAWL_API_KEY' } },
  },
  index: {
    provider: 'algolia',
    config: {
      appId: { kind: 'variable', name: 'ALGOLIA_APP_ID' },
      apiKey: { kind: 'secret', name: 'ALGOLIA_API_KEY' },
    },
  },
};

describe('knowledge provider deploy preflight', () => {
  it('collects declared secret and variable names from crawler and index declarations', () => {
    const artifact = artifactWith([byoComponent]);
    const secretRefs = artifactSecretBindings(artifact).map((binding) => binding.secretRef);
    expect(secretRefs).toContain('FIRECRAWL_API_KEY');
    expect(secretRefs).toContain('ALGOLIA_API_KEY');
    expect(artifactVariableBindings(artifact)).toContain('ALGOLIA_APP_ID');
  });

  it('fails the preflight closed naming each unset reference', () => {
    const artifact = artifactWith([byoComponent]);
    const errors = missingServerConfigErrors(artifact, {}, {});
    const joined = JSON.stringify(errors);
    expect(joined).toContain('FIRECRAWL_API_KEY');
    expect(joined).toContain('ALGOLIA_API_KEY');
    expect(joined).toContain('ALGOLIA_APP_ID');
  });

  it('passes when every declared reference has a value and managed defaults declare nothing', () => {
    const artifact = artifactWith([byoComponent]);
    expect(
      missingServerConfigErrors(
        artifact,
        { FIRECRAWL_API_KEY: 'fc-1', ALGOLIA_API_KEY: 'al-1' },
        { ALGOLIA_APP_ID: 'APP1' },
      ),
    ).toEqual([]);
    expect(artifactSecretBindings(artifactWith([{ name: 'product' }]))).toEqual([]);
    expect(artifactVariableBindings(artifactWith(undefined))).toEqual([]);
  });
});
