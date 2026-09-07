import { describe, expect, it, vi } from 'vitest';
import type {
  OperationEvidence,
  OperationEvidenceIntent,
  OperationEvidencePort,
} from '../src/operation-evidence.js';
import { withOperationEvidence } from '../src/operation-evidence.js';

const intent: OperationEvidenceIntent = {
  id: 'trusted',
  tool: 'submit',
  arguments: { private: 'never-in-history' },
  operation: {
    resolved: true,
    connectorId: 'api',
    connectorVersion: '1',
    operation: 'submit',
    signatureHash: 'sig',
  },
};

describe('operation evidence dispatch boundary', () => {
  it('persists intent before I/O and distinguishes accepted from completed', async () => {
    const events: string[] = [];
    const finish = vi.fn(async (evidence: OperationEvidence) => {
      events.push(evidence.outcome);
    });
    const port: OperationEvidencePort = {
      begin: async () => {
        events.push('intent');
        return { finish };
      },
    };
    const result = await withOperationEvidence(port, intent, async (report) => {
      events.push('io');
      report({ outcome: 'accepted', reference: 'job-42' });
      return { ok: true, output: { job: 'job-42' } };
    });
    expect(result.ok).toBe(true);
    expect(events).toEqual(['intent', 'io', 'accepted']);
    expect(finish).toHaveBeenCalledWith({ outcome: 'accepted', reference: 'job-42' });
  });
  it('never dispatches when intent storage fails or an identity was already spent', async () => {
    const work = vi.fn(async () => ({ ok: true as const, output: {} }));
    for (const begin of [
      async () => undefined,
      async () => {
        throw new Error('database-private');
      },
    ]) {
      expect((await withOperationEvidence({ begin }, intent, work)).ok).toBe(false);
    }
    expect(work).not.toHaveBeenCalled();
  });
  it('records ambiguous failures as unknown and never retains arbitrary output or errors', async () => {
    const finish = vi.fn(async () => undefined);
    const result = await withOperationEvidence(
      { begin: async () => ({ finish }) },
      intent,
      async () => {
        throw new Error('provider secret');
      },
    );
    expect(finish).toHaveBeenCalledWith({ outcome: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('provider secret');
  });
  it('does not infer business completion from a successful unannotated tool', async () => {
    const finish = vi.fn(async () => undefined);
    await withOperationEvidence({ begin: async () => ({ finish }) }, intent, async () => ({
      ok: true,
      output: { token: 'private' },
    }));
    expect(finish).toHaveBeenCalledWith({ outcome: 'returned' });
  });
  it('refuses success if terminal persistence failed and drops bearer URLs from evidence', async () => {
    const finish = vi.fn(async () => {
      throw new Error('database failure');
    });
    const result = await withOperationEvidence(
      { begin: async () => ({ finish }) },
      intent,
      async (report) => {
        report({ outcome: 'completed', reference: 'https://provider.test/?token=secret' });
        return { ok: true, output: {} };
      },
    );
    expect(finish).toHaveBeenCalledWith({ outcome: 'unknown' });
    expect(result).toMatchObject({ ok: false, error: { reason: 'operation_outcome_unknown' } });
  });
});
