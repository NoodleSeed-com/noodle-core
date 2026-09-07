import type { IncomingMessage, ServerResponse } from 'node:http';
import { ADMISSION_DEFAULTS } from '@noodle-borg/admission-limits/portable';
import {
  type AssistantSessionRecord,
  parseAssistantContextPreferences,
  resolveInvocationContextSnapshot,
  surfaceEnvelope,
  withAssistantSessionExecutionAuthority,
} from '@noodle-borg/assistant-gateway/portable';
import type { ExecuteDeps } from '@noodle-borg/runtime';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { assistantSuggestionsRequestSchema } from '@noodle-borg/wire-contracts';
import type { AssistantRouteDeps } from './assistant.js';
import { generateInitialAssistantSuggestions } from './assistant-agent.js';
import { applyBrowserCors, authenticateSession, now } from './assistant-route-http.js';
import { sessionScopedTarget } from './assistant-session-target.js';

/** Generate or replay the one bounded initial prompt set for a session whose config omitted it. */
export async function handleAssistantSuggestions(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
): Promise<void> {
  const session = await authenticateSession(req, res, deps);
  if (!session) return;
  applyBrowserCors(req, res, session.origin);
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const parsed = assistantSuggestionsRequestSchema.safeParse(body.value);
  if (!parsed.success) return sendJson(res, 400, { error: 'invalid suggestions request' });

  // The server enforces omission too: a modified client cannot spend a model call when the resolved
  // developer/operator configuration supplied either exact prompts or an explicit empty array.
  if (session.configuration?.assistant?.suggestedPrompts !== undefined) {
    return writeEmptySuggestions(res, session.origin);
  }
  if (session.history.length > 0) return writeEmptySuggestions(res, session.origin);
  if (!(await publicSuggestionWorkIsAvailable(session, deps))) {
    return sendJson(res, 429, {
      error: 'assistant is unavailable right now',
      code: 'daily_turn_budget_exhausted',
    });
  }
  const claim = await deps.store.claimInitialSuggestions(session.id);
  if (claim.disposition === 'ready') {
    return writeSuggestions(res, session.origin, claim.prompts);
  }
  if (claim.disposition !== 'generate') return writeEmptySuggestions(res, session.origin);

  const target = await sessionScopedTarget(deps.registry, session);
  if (!target) {
    await deps.store.failInitialSuggestions(session.id);
    return writeEmptySuggestions(res, session.origin);
  }
  const clientContext =
    parsed.data.clientContext === undefined
      ? undefined
      : parseAssistantContextPreferences(parsed.data.clientContext);
  if (clientContext?.ok === false) {
    await deps.store.failInitialSuggestions(session.id);
    return sendJson(res, 400, { error: 'invalid client context' });
  }
  const context = await resolveInvocationContextSnapshot({
    artifact: target.served.artifact,
    executeDeps: withAssistantSessionExecutionAuthority(
      target.served.deps as ExecuteDeps,
      target.served.artifact,
      session,
    ),
    caller: session.caller,
    instant: now(deps),
    ...(session.preferences ? { applicationPreference: session.preferences } : {}),
    ...(clientContext?.ok ? { clientHint: clientContext.value } : {}),
  });
  try {
    const prompts = await generateInitialAssistantSuggestions(
      target,
      session,
      context,
      deps,
      parsed.data.modelContext,
      parsed.data.pageContext,
    );
    if (prompts.length === 0) {
      await deps.store.failInitialSuggestions(session.id);
      return writeEmptySuggestions(res, session.origin);
    }
    await deps.store.completeInitialSuggestions(session.id, prompts);
    return writeSuggestions(res, session.origin, prompts);
  } catch {
    await deps.store.failInitialSuggestions(session.id);
    return writeEmptySuggestions(res, session.origin);
  }
}

async function publicSuggestionWorkIsAvailable(
  session: AssistantSessionRecord,
  deps: AssistantRouteDeps,
): Promise<boolean> {
  if (session.publicEmbedId === undefined) return true;
  const embed = await deps.publicEmbeds?.lookup(session.publicEmbedId);
  if (!embed) return false;
  const bounds =
    session.modelSource !== 'noodle-managed'
      ? undefined
      : (
          await deps.managedModelResolver?.resolve({
            tenant: session.tenant,
            deploymentId: session.deploymentId,
          })
        )?.publicAdmission;
  const envelope = surfaceEnvelope(deps.admissionEnvelope ?? ADMISSION_DEFAULTS, embed, bounds);
  return envelope.mintsPerDay > 0 && envelope.turnsPerDay > 0;
}

function writeSuggestions(res: ServerResponse, origin: string, prompts: readonly string[]): void {
  writeHeaders(res, origin);
  res.write(`event: suggested_prompts\ndata: ${JSON.stringify({ phase: 'initial', prompts })}\n\n`);
  res.end('event: done\ndata: {}\n\n');
}

function writeEmptySuggestions(res: ServerResponse, origin: string): void {
  writeHeaders(res, origin);
  res.end('event: done\ndata: {}\n\n');
}

function writeHeaders(res: ServerResponse, origin: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': origin,
    vary: 'Origin',
  });
}
