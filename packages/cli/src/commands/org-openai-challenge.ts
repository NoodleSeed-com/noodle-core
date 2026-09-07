import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import { authRequired } from './resource-shared.js';
import { commandFailure, parseCommandFlags, printCliFailure, usageError } from './shared.js';

interface OpenAIAppsChallengeBody {
  readonly orgSlug: string;
  readonly configured: boolean;
  readonly challengeUrl: string | null;
  readonly challenge?: string;
  readonly updatedAt?: string;
  readonly updatedByEmail?: string;
}

export async function runOrgsOpenAIChallenge(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseOpenAIChallengeArgs(rest);
  const [action, slug] = args.positional;
  const json = args.json;
  if (args.parseError !== undefined) {
    return printCliFailure(
      'orgs',
      usageError(args.parseError, 'noodle orgs openai-challenge --help'),
      json,
    );
  }
  if (action !== 'get' && action !== 'set' && action !== 'clear') {
    return printCliFailure(
      'orgs',
      usageError(
        'orgs openai-challenge requires get, set, or clear',
        'noodle orgs openai-challenge get <org>',
      ),
      json,
    );
  }
  if (slug === undefined || args.positional.length !== 2) {
    return printCliFailure(
      'orgs',
      usageError(
        'orgs openai-challenge requires an org slug',
        `noodle orgs openai-challenge ${action} <org>`,
      ),
      json,
    );
  }
  if (action === 'set' && args.code === undefined) {
    return printCliFailure(
      'orgs',
      usageError(
        'orgs openai-challenge set requires --code',
        'noodle orgs openai-challenge set <org> --code <challenge>',
      ),
      json,
    );
  }
  const { serviceUrl, token } = await resolveControlPlaneToken({
    serviceFlag: args.serviceFlag,
    authFlag: args.authFlag,
    env,
    home,
  });
  if (token === undefined) return printCliFailure('orgs', authRequired(), json);
  const url = `${serviceUrl}/v1/orgs/${encodeURIComponent(slug)}/openai-apps-challenge`;
  try {
    if (action === 'get') {
      const body = await serviceJson<{ ok: true; data: OpenAIAppsChallengeBody }>(url, token);
      if (json) {
        printJsonOk(body.data);
        return EXIT.OK;
      }
      printOpenAIAppsChallenge(body.data);
      return EXIT.OK;
    }
    if (action === 'set') {
      const body = await serviceJson<{ ok: true; data: OpenAIAppsChallengeBody }>(url, token, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge: args.code }),
      });
      if (json) {
        printJsonOk(body.data);
        return EXIT.OK;
      }
      console.log(`OpenAI Apps challenge set for ${body.data.orgSlug}.`);
      if (body.data.challengeUrl) console.log(`URL: ${body.data.challengeUrl}`);
      return EXIT.OK;
    }
    const body = await serviceJson<{ ok: true; cleared: boolean }>(url, token, {
      method: 'DELETE',
    });
    if (json) {
      printJsonOk({ org: slug, cleared: body.cleared });
      return EXIT.OK;
    }
    console.log(
      body.cleared
        ? `OpenAI Apps challenge cleared for ${slug}.`
        : `No OpenAI Apps challenge was configured for ${slug}.`,
    );
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'orgs',
      commandFailure(error, 'noodle orgs openai-challenge get <org>'),
      json,
    );
  }
}

function printOpenAIAppsChallenge(data: OpenAIAppsChallengeBody): void {
  console.log(`org:        ${data.orgSlug}`);
  console.log(`configured: ${data.configured ? 'yes' : 'no'}`);
  console.log(`url:        ${data.challengeUrl ?? 'not configured'}`);
  if (data.challenge !== undefined) console.log(`challenge:  ${data.challenge}`);
  if (data.updatedAt !== undefined) console.log(`updated:    ${data.updatedAt}`);
  if (data.updatedByEmail !== undefined) console.log(`updatedBy:  ${data.updatedByEmail}`);
}

function parseOpenAIChallengeArgs(rest: readonly string[]): {
  readonly serviceFlag?: string;
  readonly authFlag?: string;
  readonly code?: string;
  readonly json: boolean;
  readonly positional: readonly string[];
  readonly parseError?: string;
} {
  return parseCommandFlags(rest, {
    values: {
      '--service': 'serviceFlag',
      '--auth-token': 'authFlag',
      '--code': 'code',
    },
    booleans: { '--json': 'json' },
  });
}
