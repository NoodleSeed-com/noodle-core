import type { McpOAuthTokens } from '@noodle-borg/auth';
import type { LocalDevtoolsDelegatedCredentialSink } from '@noodle-borg/service/local';
import { decodeJwt } from 'jose';
import { DevtoolsAuthError, type DevtoolsCustomerAuth } from './devtools-auth-types.js';

export async function storeDevtoolsDelegatedCredential(options: {
  readonly auth: DevtoolsCustomerAuth;
  readonly resource: string;
  readonly tokens: McpOAuthTokens;
  readonly sink: LocalDevtoolsDelegatedCredentialSink | undefined;
}): Promise<void> {
  const provider =
    options.auth.kind === 'firebase' || options.auth.kind === 'microsoft'
      ? options.auth.kind
      : undefined;
  if (provider === undefined || options.sink === undefined) return;
  if (options.tokens.refreshToken === undefined) {
    options.sink.clearResource(options.resource);
    return;
  }
  let subject: string | undefined;
  try {
    const claims = decodeJwt(options.tokens.accessToken);
    subject = typeof claims.sub === 'string' ? claims.sub : undefined;
  } catch {
    // The loopback verifier remains authoritative. Decoding here only selects the same subject-keyed
    // broker slot; an unsigned/forged value cannot produce a verified MCP caller.
  }
  if (subject === undefined || subject.length === 0) {
    throw new DevtoolsAuthError(
      'delegated_credential_subject_missing',
      `${provider === 'firebase' ? 'Firebase' : 'Microsoft'} did not return a subject-bound identity token.`,
    );
  }
  await options.sink.setCredential({
    resource: options.resource,
    provider,
    subject,
    refreshToken: options.tokens.refreshToken,
  });
}
