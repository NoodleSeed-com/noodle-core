import type { HttpAuthDef } from './schema.js';
import { collectVariableReferences } from './variables.js';

export function collectVariablesFromHttpAuth(auth: HttpAuthDef, out: Set<string>): void {
  if (auth.kind === 'clientCredentials') {
    collectVariableReferences(auth.tokenUrl, out);
    collectVariableReferences(auth.clientId, out);
    if (auth.audience !== undefined) collectVariableReferences(auth.audience, out);
    return;
  }
  if (auth.kind === 'delegatedOAuth') {
    if (auth.tokenUrl !== undefined) collectVariableReferences(auth.tokenUrl, out);
    if (auth.clientId !== undefined) collectVariableReferences(auth.clientId, out);
    return;
  }
  if (auth.kind === 'delegatedSessionCookie') {
    collectVariableReferences(auth.sessionUrl, out);
    return;
  }
  if (auth.kind === 'delegatedTokenExchange') {
    collectVariableReferences(auth.tokenUrl, out);
    collectVariableReferences(auth.clientId, out);
    if (auth.audience !== undefined) collectVariableReferences(auth.audience, out);
  }
}
