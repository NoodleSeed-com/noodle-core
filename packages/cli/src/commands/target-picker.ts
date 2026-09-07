/**
 * TTY-only pickers for an unresolved org/app/env target: `apps list`/`deployments list` (org),
 * `envs list` (org or app), and `apps inspect`/`envs inspect` (the missing positional). Every
 * picker is a thin wrapper over `prompts.ts`'s `select`, sharing its injectable io/TTY seam so
 * tests can drive it deterministically (see `prompts.ts`'s doc comment on the interactive
 * seam). Candidate fetches (`fetchOrgCandidates` et al) live in `resource-shared.ts`; this
 * module owns presentation (`pickOrg`/`pickApp`/`pickEnv`, the `canPickTarget` gate, the dim
 * hint line) and the per-command orchestration that ties fetch + picker + hint together.
 *
 * The picker never fires under `--json`, a non-TTY stream, or without a resolvable token — in
 * every one of those cases (or an empty candidate list, or an aborted picker) the orchestration
 * functions resolve `undefined` and the caller falls back to its existing, unchanged failure
 * path (a structured `target_required`/usage error), so headless/agent callers see byte-for-byte
 * the same behavior as before this module existed.
 */

import { isInteractive, type SelectOption, select } from '../prompts.js';
import {
  type AppSummary,
  dimText,
  type EnvSummary,
  fetchAppCandidates,
  fetchEnvCandidates,
  fetchOrgCandidates,
  type OrgCandidate,
} from './resource-shared.js';

export interface PickerIO {
  readonly input?: NodeJS.ReadStream & { isTTY?: boolean };
  readonly output?: NodeJS.WriteStream;
}

interface TokenResolved {
  readonly serviceUrl: string;
  readonly token?: string;
}

/** Whether an interactive target picker should fire: a real TTY input+output, no `--json`, and a token. */
export function canPickTarget(
  json: boolean,
  token: string | undefined,
  io: PickerIO = {},
): boolean {
  if (json || token === undefined) return false;
  return isInteractive(io.input ?? process.stdin, io.output ?? process.stdout);
}

/** Pick an org from candidates. Resolves the chosen slug; rejects `AbortPromptError` on Esc/Ctrl+C. */
export function pickOrg(candidates: readonly OrgCandidate[], io: PickerIO = {}): Promise<string> {
  const options: SelectOption<string>[] = candidates.map((org) => ({
    value: org.slug,
    label: org.slug,
    ...(org.displayName !== undefined ? { hint: org.displayName } : {}),
  }));
  return select('Which org?', options, io);
}

/** Pick an app from candidates. Resolves the chosen slug; rejects `AbortPromptError` on Esc/Ctrl+C. */
export function pickApp(candidates: readonly AppSummary[], io: PickerIO = {}): Promise<string> {
  const options: SelectOption<string>[] = candidates.map((app) => ({
    value: app.appSlug,
    label: app.appSlug,
  }));
  return select('Which app?', options, io);
}

/** Pick an env from candidates. Resolves the chosen name; rejects `AbortPromptError` on Esc/Ctrl+C. */
export function pickEnv(candidates: readonly EnvSummary[], io: PickerIO = {}): Promise<string> {
  const options: SelectOption<string>[] = candidates.map((env) => ({
    value: env.envName,
    label: env.envName,
  }));
  return select('Which env?', options, io);
}

/** Print the dim non-interactive-equivalent hint line after a picker resolves a target. */
function printPickerHint(hintCommand: string, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${dimText(`hint: ${hintCommand}`, stream)}\n`);
}

/**
 * The shared picker orchestration: gate on `canPickTarget`, fetch the candidates, present the
 * picker, and print the dim hint. Returns the chosen value, or `undefined` when the picker
 * doesn't fire, has nothing to offer, or the user aborts — the caller then falls back to its
 * existing failure. The `pick*Interactively` wrappers below bind it to the org/app/env
 * fetch + picker pair; `canPickTarget` has already guaranteed `resolved.token` is defined when
 * `fetchCandidates` runs.
 */
async function runTargetPicker<T>(
  resolved: TokenResolved,
  json: boolean,
  io: PickerIO,
  fetchCandidates: (token: string) => Promise<readonly T[]>,
  pick: (candidates: readonly T[], io: PickerIO) => Promise<string>,
  hintCommand: (choice: string) => string,
): Promise<string | undefined> {
  if (!canPickTarget(json, resolved.token, io)) return undefined;
  const candidates = await fetchCandidates(resolved.token as string);
  if (candidates.length === 0) return undefined;
  try {
    const choice = await pick(candidates, io);
    printPickerHint(hintCommand(choice), io.output);
    return choice;
  } catch {
    return undefined;
  }
}

/** Attempt the org picker for an unresolved org target. */
export function pickOrgInteractively(
  resolved: TokenResolved,
  json: boolean,
  hintCommand: (org: string) => string,
  io: PickerIO = {},
): Promise<string | undefined> {
  return runTargetPicker(
    resolved,
    json,
    io,
    (token) => fetchOrgCandidates(resolved.serviceUrl, token),
    pickOrg,
    hintCommand,
  );
}

/** Attempt the app picker, scoped to the apps in a resolved org. */
export function pickAppInteractively(
  resolved: TokenResolved,
  org: string,
  json: boolean,
  hintCommand: (app: string) => string,
  io: PickerIO = {},
): Promise<string | undefined> {
  return runTargetPicker(
    resolved,
    json,
    io,
    (token) => fetchAppCandidates(resolved.serviceUrl, org, token),
    pickApp,
    hintCommand,
  );
}

/** Attempt the env picker, scoped to the envs of a resolved org/app. */
export function pickEnvInteractively(
  resolved: TokenResolved,
  org: string,
  app: string,
  json: boolean,
  hintCommand: (env: string) => string,
  io: PickerIO = {},
): Promise<string | undefined> {
  return runTargetPicker(
    resolved,
    json,
    io,
    (token) => fetchEnvCandidates(resolved.serviceUrl, org, app, token),
    pickEnv,
    hintCommand,
  );
}
