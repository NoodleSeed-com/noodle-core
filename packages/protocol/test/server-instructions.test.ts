import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { buildDeps, connectClientTo, resolvedArtifact } from './harness.js';

/** The resolved fixture artifact with `server.instructions` set. */
function artifactWithInstructions(instructions: string): RuntimeArtifact {
  const base = resolvedArtifact();
  return { ...base, server: { ...base.server, instructions } };
}

describe('server.instructions on initialize', () => {
  it('returns artifact instructions in the initialize result', async () => {
    const instructions = 'Call get_order before answering order questions.';
    const client = await connectClientTo({
      artifact: artifactWithInstructions(instructions),
      deps: buildDeps(),
    });
    expect(client.getInstructions()).toBe(instructions);
  });

  it('omits instructions when the artifact has none', async () => {
    const client = await connectClientTo({ artifact: resolvedArtifact(), deps: buildDeps() });
    expect(client.getInstructions()).toBeUndefined();
  });

  it('never projects assistant surface instructions into MCP initialize', async () => {
    const base = resolvedArtifact();
    const artifact = {
      ...base,
      server: {
        ...base.server,
        instructions: 'Shared MCP instructions.',
        assistant: {
          model: {
            kind: 'openai-compatible' as const,
            baseUrl: 'https://models.example/v1',
            model: 'assistant-model',
            apiKey: 'ASSISTANT_MODEL_API_KEY',
          },
          allowedOrigins: ['https://www.example.com'],
          surfaces: [
            {
              mode: 'public' as const,
              origins: ['https://www.example.com'],
              capabilities: [],
              instructions: 'Public website instructions that MCP must never receive.',
            },
          ],
        },
      },
    } satisfies RuntimeArtifact;

    const client = await connectClientTo({ artifact, deps: buildDeps() });
    expect(client.getInstructions()).toBe('Shared MCP instructions.');
    expect(client.getInstructions()).not.toContain('Public website instructions');
  });
});
