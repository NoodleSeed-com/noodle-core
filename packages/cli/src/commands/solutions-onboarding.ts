import {
  BusinessNoticeClientResponseSchema,
  BusinessNoticeSaveRequestSchema,
  OrganizationAgreementAcceptRequestSchema,
  OrganizationAgreementClientResponseSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import {
  authRequired,
  parseCommandFlags,
  printCliFailure,
  serviceFailure,
  usageError,
} from './shared.js';

export async function runSolutionOnboarding(
  family: 'agreement' | 'notice',
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  options: { readonly fetchImpl?: typeof fetch },
): Promise<number> {
  const command = `solutions ${family}`;
  const args = parseCommandFlags(rest, {
    values: {
      '--service': 'service',
      '--auth-token': 'authToken',
      '--org': 'org',
      '--version': 'version',
      '--document-digest': 'documentDigest',
      '--expected-revision': 'expectedRevision',
      '--display-name': 'displayName',
      '--privacy-url': 'privacyUrl',
      '--support-url': 'supportUrl',
    },
    booleans: { '--json': 'json', '--accept': 'accept' },
  });
  const [action, id, ...extra] = args.positional;
  const usage = (message: string) =>
    printCliFailure(
      command,
      usageError(
        message,
        `noodle solutions ${family} ${family === 'agreement' ? 'get|accept' : 'get|set <installation>'} --org <org> [options]`,
      ),
      args.json,
    );
  if (
    args.parseError ||
    !args.org ||
    extra.length ||
    (family === 'agreement' ? id !== undefined : !id) ||
    (action !== 'get' && action !== (family === 'agreement' ? 'accept' : 'set'))
  )
    return usage(args.parseError ?? 'Specify an organization and a supported action.');
  let input: unknown;
  if (action === 'accept') {
    const parsed = OrganizationAgreementAcceptRequestSchema.safeParse({
      version: args.version,
      documentDigest: args.documentDigest,
      accepted: args.accept,
    });
    if (!parsed.success)
      return usage(
        'Acceptance requires --version, --document-digest and explicit --accept after reviewing the current documents.',
      );
    input = parsed.data;
  }
  if (action === 'set') {
    const parsed = BusinessNoticeSaveRequestSchema.safeParse({
      expectedRevision:
        args.expectedRevision === undefined ? undefined : Number(args.expectedRevision),
      notice: {
        displayName: args.displayName,
        privacyUrl: args.privacyUrl,
        supportUrl: args.supportUrl,
      },
    });
    if (!parsed.success)
      return usage(
        'Set requires --expected-revision, --display-name, a public HTTPS --privacy-url and HTTPS or mailto --support-url.',
      );
    input = parsed.data;
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (!resolved.token) return printCliFailure(command, authRequired(), args.json);
  const path = `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(args.org)}/${family === 'agreement' ? 'agreement' : `solution-installations/${encodeURIComponent(id ?? '')}/notice`}`;
  try {
    const result = await serviceJson<unknown>(
      path,
      resolved.token,
      input === undefined
        ? {}
        : {
            method: family === 'agreement' ? 'POST' : 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          },
      options.fetchImpl ?? fetch,
    );
    if (family === 'agreement') {
      const { data } = OrganizationAgreementClientResponseSchema.parse(result);
      if (args.json) printJsonOk(data);
      else
        console.log(
          [
            `Agreement: ${data.accepted ? 'accepted' : 'not accepted'}`,
            `Owner acceptance: ${data.canAccept ? 'permitted' : 'not permitted'}`,
            ...(data.required
              ? [
                  `Version: ${data.required.version}`,
                  `Document digest: ${data.required.documentDigest}`,
                  `Terms: ${data.required.terms.url}`,
                  `Privacy: ${data.required.privacy.url}`,
                  `Data processing: ${data.required.processing.url}`,
                ]
              : ['Current agreement documents are unavailable.']),
            ...(data.receipt ? [`Recorded: ${data.receipt.acceptedAt}`] : []),
          ].join('\n'),
        );
    } else {
      const { data } = BusinessNoticeClientResponseSchema.parse(result);
      if (args.json) printJsonOk(data);
      else
        console.log(
          [
            `Revision: ${data.revision}`,
            `Edit: ${data.canEdit ? 'permitted' : 'not permitted'}`,
            ...(data.notice
              ? [
                  `Business: ${data.notice.displayName}`,
                  `Privacy: ${data.notice.privacyUrl}`,
                  `Support: ${data.notice.supportUrl}`,
                ]
              : ['Business notice is not configured.']),
          ].join('\n'),
        );
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      command,
      serviceFailure(command, error, `noodle solutions ${family} get`),
      args.json,
    );
  }
}
