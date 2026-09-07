import type { GoogleIdTokenVerifier } from '@noodle-borg/control-plane/portable';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunningService } from '../src/serve.js';
import { serveService } from '../src/serve.js';

const WORKLOAD_SUBJECT = '109876543210987654321';

describe('human/workload Google gate separation', () => {
  let running: RunningService | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('retains an exact workload gate after broad human Google compatibility is disabled', async () => {
    running = await start(false);

    const workload = await whoami(running.url, 'workload-token');
    expect(workload.status).toBe(200);
    expect(await workload.json()).toMatchObject({ identity: { subject: WORKLOAD_SUBJECT } });

    const human = await whoami(running.url, 'human-token');
    expect(human.status).toBe(401);
  });

  it('allows a human fallback alongside the exact workload gate only when explicitly enabled', async () => {
    running = await start(true);

    const human = await whoami(running.url, 'human-token');
    expect(human.status).toBe(200);
    expect(await human.json()).toMatchObject({ identity: { subject: 'human-google-sub' } });
  });

  it('does not widen the workload audience with human compatibility audiences', async () => {
    const audiences: (string | readonly string[])[] = [];
    running = await serveService({
      port: 0,
      googleClientId: 'workload-control-plane-client',
      googleAdditionalAudiences: ['human-console-client'],
      googleWorkloadSubjects: [WORKLOAD_SUBJECT],
      googleHumanAuthCompatibility: false,
      googleVerifier: {
        verify: async (_token, audience) => {
          audiences.push(audience);
          return {
            subject: WORKLOAD_SUBJECT,
            email: 'github-deployer@example.iam.gserviceaccount.com',
          };
        },
      },
    });

    expect((await whoami(running.url, 'workload-token')).status).toBe(200);
    expect(audiences).toEqual(['workload-control-plane-client']);
  });

  it('keeps additional audiences on the human compatibility gate only', async () => {
    const audiences: (string | readonly string[])[] = [];
    running = await serveService({
      port: 0,
      googleClientId: 'workload-control-plane-client',
      googleAdditionalAudiences: ['human-console-client'],
      googleWorkloadSubjects: [WORKLOAD_SUBJECT],
      googleHumanAuthCompatibility: true,
      controlPlaneSignupMode: 'public',
      googleVerifier: {
        verify: async (_token, audience) => {
          audiences.push(audience);
          return { subject: 'human-google-sub', email: 'human@example.test' };
        },
      },
    });

    expect((await whoami(running.url, 'human-token')).status).toBe(200);
    expect(audiences).toEqual([
      'workload-control-plane-client',
      ['workload-control-plane-client', 'human-console-client'],
    ]);
  });

  it('fails closed when the retained workload gate has no exact audience or subject set', async () => {
    await expect(
      serveService({
        port: 0,
        googleWorkloadSubjects: [WORKLOAD_SUBJECT],
        googleHumanAuthCompatibility: false,
      }),
    ).rejects.toThrow(/workload.*audience/i);
    await expect(
      serveService({
        port: 0,
        googleClientId: 'control-plane-client',
        googleHumanAuthCompatibility: false,
      }),
    ).rejects.toThrow(/workload.*subject/i);
  });
});

async function start(humanCompatibility: boolean): Promise<RunningService> {
  const verifier: GoogleIdTokenVerifier = {
    verify: async (token) =>
      token === 'workload-token'
        ? {
            subject: WORKLOAD_SUBJECT,
            email: 'github-deployer@example.iam.gserviceaccount.com',
          }
        : { subject: 'human-google-sub', email: 'human@example.test' },
  };
  return serveService({
    port: 0,
    googleClientId: 'control-plane-client',
    googleWorkloadSubjects: [WORKLOAD_SUBJECT],
    googleHumanAuthCompatibility: humanCompatibility,
    controlPlaneSignupMode: 'public',
    googleVerifier: verifier,
  });
}

function whoami(base: string, token: string): Promise<Response> {
  return fetch(new URL('/v1/whoami', base), {
    headers: { authorization: `Bearer ${token}` },
  });
}
