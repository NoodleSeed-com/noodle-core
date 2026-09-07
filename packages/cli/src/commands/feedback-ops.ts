/**
 * `noodle feedback` — send product feedback to the Noodle Seed team (ADR 0166). One-shot:
 * `noodle feedback "message" [--type ...] [--severity ...] [--area ...]`, with an interactive
 * message prompt on a TTY. Validates locally with the same `@noodle-borg/wire-contracts` schema
 * the service enforces, so a bad flag fails fast before any network call. Light diagnostics
 * (CLI version, platform, Node version) are attached and echoed to the user before sending —
 * never code, file contents, or environment values. The Agent Kit feedback skill teaches the
 * customer's coding agent to drive this command proactively with sanitized content.
 */
import { arch, release } from 'node:os';
import {
  FEEDBACK_AGENT_MODEL_MAX,
  FEEDBACK_AGENT_MODEL_MIN,
  FEEDBACK_AGENT_NAME_MAX,
  FEEDBACK_AGENT_NAME_MIN,
  FEEDBACK_AREAS,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_MESSAGE_MIN,
  FEEDBACK_SEVERITIES,
  FEEDBACK_TITLE_MAX,
  FEEDBACK_TITLE_MIN,
  FEEDBACK_TYPES,
  type FeedbackResponse,
  type FeedbackSubmission,
  FeedbackSubmissionSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import {
  RefreshTokenRejectedError,
  resolveControlPlaneToken,
  serviceJson,
} from '../control-plane.js';
import { AbortPromptError, isInteractive, text } from '../prompts.js';
import { currentCliVersion } from '../update.js';
import { EXIT, type JsonFieldError, printJsonOk, printRawJsonForHumanDebug } from './output.js';
import { authRequired } from './resource-shared.js';
import { type CliFailure, printCliFailure, serviceFailure } from './shared.js';

const FEEDBACK_DESTINATION = 'Noodle Seed private feedback tracker' as const;
const VALUE_FLAGS = [
  'message',
  'title',
  'type',
  'severity',
  'area',
  'agent',
  'model',
  'service',
  'auth-token',
] as const;
const BOOLEAN_FLAGS = ['json', 'dry-run'] as const;
const SUPPORTED_FLAGS = [...VALUE_FLAGS, ...BOOLEAN_FLAGS].map((flag) => `--${flag}`).join(' | ');

export interface FeedbackDiagnostics {
  readonly cliVersion: string;
  readonly platform: string;
  readonly nodeVersion: string;
}

interface FeedbackPreview {
  readonly mode: 'preview';
  readonly willSubmit: false;
  readonly destination: typeof FEEDBACK_DESTINATION;
  readonly submission: FeedbackSubmission;
}

interface FeedbackArgs {
  readonly message?: string;
  readonly title?: string;
  readonly type?: string;
  readonly severity?: string;
  readonly area?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly service?: string;
  readonly authToken?: string;
}

interface FeedbackInputFailure {
  readonly message: string;
  readonly errors: readonly JsonFieldError[];
}

type FeedbackArgsResult =
  | { readonly ok: true; readonly args: FeedbackArgs }
  | { readonly ok: false; readonly error: FeedbackInputFailure };

export type FeedbackPayloadResult =
  | { readonly ok: true; readonly payload: FeedbackSubmission }
  | { readonly ok: false; readonly error: FeedbackInputFailure };

function collectFeedbackDiagnostics(): FeedbackDiagnostics {
  return {
    cliVersion: currentCliVersion().slice(0, 64),
    platform: `${process.platform} ${arch()} ${release()}`.slice(0, 64),
    nodeVersion: process.version.slice(0, 64),
  };
}

function fieldFailure(
  code: string,
  path: string,
  message: string,
  expected: string,
  got: string,
): FeedbackInputFailure {
  return { message, errors: [{ code, path, message, expected, got }] };
}

function parseFeedbackArgs(rest: readonly string[]): FeedbackArgsResult {
  let message: string | undefined;
  let title: string | undefined;
  let type: string | undefined;
  let severity: string | undefined;
  let area: string | undefined;
  let agent: string | undefined;
  let model: string | undefined;
  let service: string | undefined;
  let authToken: string | undefined;
  let json = false;
  let dryRun = false;
  let positionalMessage: string | undefined;
  const seen = new Set<string>();

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-')) {
        const equalsIndex = arg.indexOf('=');
        const rejectedFlag = safeShortFlag(equalsIndex === -1 ? arg : arg.slice(0, equalsIndex));
        return {
          ok: false,
          error: fieldFailure(
            'unknown_flag',
            'arguments',
            `Unknown feedback flag "${rejectedFlag}".`,
            SUPPORTED_FLAGS,
            rejectedFlag,
          ),
        };
      }
      if (positionalMessage !== undefined) {
        return {
          ok: false,
          error: fieldFailure(
            'extra_argument',
            'message',
            'Only one positional feedback message is accepted.',
            'one positional message',
            '2 positional values',
          ),
        };
      }
      positionalMessage = arg;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const name = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    if (
      !VALUE_FLAGS.includes(name as (typeof VALUE_FLAGS)[number]) &&
      !BOOLEAN_FLAGS.includes(name as (typeof BOOLEAN_FLAGS)[number])
    ) {
      const rejectedFlag = safeFlagName(name);
      return {
        ok: false,
        error: fieldFailure(
          'unknown_flag',
          'arguments',
          `Unknown feedback flag "${rejectedFlag}".`,
          SUPPORTED_FLAGS,
          rejectedFlag,
        ),
      };
    }
    if (seen.has(name)) {
      return {
        ok: false,
        error: fieldFailure(
          'duplicate_flag',
          name,
          `Feedback flag "--${name}" may only be supplied once.`,
          'one occurrence',
          '2 occurrences',
        ),
      };
    }
    seen.add(name);

    if (BOOLEAN_FLAGS.includes(name as (typeof BOOLEAN_FLAGS)[number])) {
      if (inlineValue !== undefined) {
        return {
          ok: false,
          error: fieldFailure(
            'unexpected_value',
            name,
            `Feedback flag "--${name}" does not accept a value.`,
            'boolean flag without a value',
            safeRejectedString(inlineValue),
          ),
        };
      }
      if (name === 'json') json = true;
      else dryRun = true;
      continue;
    }

    const next = inlineValue ?? rest[i + 1];
    if (next === undefined || (inlineValue === undefined && next.startsWith('--'))) {
      return {
        ok: false,
        error: fieldFailure(
          'missing_value',
          name,
          `Feedback flag "--${name}" requires a value.`,
          'string value',
          'missing',
        ),
      };
    }
    if (inlineValue === undefined) i++;
    if (name === 'message') message = next;
    else if (name === 'title') title = next;
    else if (name === 'type') type = next;
    else if (name === 'severity') severity = next;
    else if (name === 'area') area = next;
    else if (name === 'agent') agent = next;
    else if (name === 'model') model = next;
    else if (name === 'service') service = next;
    else authToken = next;
  }

  if (positionalMessage !== undefined && message !== undefined) {
    return {
      ok: false,
      error: fieldFailure(
        'conflicting_input',
        'message',
        'Use either the positional feedback message or "--message", not both.',
        'positional message or --message',
        'both forms',
      ),
    };
  }

  const resolvedMessage = message ?? positionalMessage;
  return {
    ok: true,
    args: {
      ...(resolvedMessage !== undefined ? { message: resolvedMessage } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(severity !== undefined ? { severity } : {}),
      ...(area !== undefined ? { area } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(service !== undefined ? { service } : {}),
      ...(authToken !== undefined ? { authToken } : {}),
      json,
      dryRun,
    },
  };
}

function validateFeedback(
  args: FeedbackArgs,
  diagnostics: FeedbackDiagnostics,
): FeedbackPayloadResult {
  if (args.message === undefined || args.message.trim() === '') {
    return {
      ok: false,
      error: fieldFailure(
        'missing_value',
        'message',
        'A feedback message is required.',
        `string length ${FEEDBACK_MESSAGE_MIN}-${FEEDBACK_MESSAGE_MAX}`,
        args.message === undefined ? 'missing' : 'string (length 0)',
      ),
    };
  }
  if (args.model !== undefined && (args.agent === undefined || args.agent.trim() === '')) {
    return {
      ok: false,
      error: fieldFailure(
        'missing_dependency',
        'model',
        'Feedback model provenance requires an agent name.',
        '--agent <name> with --model',
        'model without agent',
      ),
    };
  }
  const parsed = FeedbackSubmissionSchema.safeParse({
    message: args.message,
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.type !== undefined ? { type: args.type } : {}),
    ...(args.severity !== undefined ? { severity: args.severity } : {}),
    ...(args.area !== undefined ? { area: args.area } : {}),
    ...(args.agent !== undefined
      ? {
          codingAgent: {
            name: args.agent,
            ...(args.model !== undefined ? { model: args.model } : {}),
          },
        }
      : {}),
    diagnostics,
  });
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => validationFieldError(args, issue.path));
    const first = errors[0];
    return {
      ok: false,
      error: {
        message: first?.message ?? 'The feedback submission is invalid.',
        errors,
      },
    };
  }
  return { ok: true, payload: parsed.data };
}

function validationFieldError(args: FeedbackArgs, path: readonly PropertyKey[]): JsonFieldError {
  const field = path.length > 0 ? path.map(String).join('.') : 'submission';
  if (field === 'message') {
    return {
      code: 'invalid_length',
      path: field,
      message: `Feedback message must be ${FEEDBACK_MESSAGE_MIN}-${FEEDBACK_MESSAGE_MAX} characters.`,
      expected: `string length ${FEEDBACK_MESSAGE_MIN}-${FEEDBACK_MESSAGE_MAX}`,
      got: safeRejectedString(args.message),
    };
  }
  if (field === 'title') {
    return {
      code: 'invalid_length',
      path: field,
      message: `Feedback title must be ${FEEDBACK_TITLE_MIN}-${FEEDBACK_TITLE_MAX} characters.`,
      expected: `string length ${FEEDBACK_TITLE_MIN}-${FEEDBACK_TITLE_MAX}`,
      got: safeRejectedString(args.title),
    };
  }
  if (field === 'type') {
    return enumFieldError(field, FEEDBACK_TYPES, args.type);
  }
  if (field === 'severity') {
    return enumFieldError(field, FEEDBACK_SEVERITIES, args.severity);
  }
  if (field === 'area') {
    return enumFieldError(field, FEEDBACK_AREAS, args.area);
  }
  if (field === 'codingAgent.name') {
    return {
      code: 'invalid_value',
      path: 'agent',
      message: `Feedback agent must be one line and ${FEEDBACK_AGENT_NAME_MIN}-${FEEDBACK_AGENT_NAME_MAX} characters.`,
      expected: `one-line string length ${FEEDBACK_AGENT_NAME_MIN}-${FEEDBACK_AGENT_NAME_MAX}`,
      got: safeRejectedString(args.agent),
    };
  }
  if (field === 'codingAgent.model') {
    return {
      code: 'invalid_value',
      path: 'model',
      message: `Feedback model must be one line and ${FEEDBACK_AGENT_MODEL_MIN}-${FEEDBACK_AGENT_MODEL_MAX} characters.`,
      expected: `one-line string length ${FEEDBACK_AGENT_MODEL_MIN}-${FEEDBACK_AGENT_MODEL_MAX}`,
      got: safeRejectedString(args.model),
    };
  }
  return {
    code: 'invalid_value',
    path: field,
    message: 'The feedback submission contains an invalid value.',
    expected: 'valid feedback field',
    got: 'invalid value',
  };
}

function enumFieldError(
  field: 'type' | 'severity' | 'area',
  choices: readonly string[],
  value: string | undefined,
): JsonFieldError {
  return {
    code: 'invalid_value',
    path: field,
    message: `Feedback ${field} must be one of ${choices.join(', ')}.`,
    expected: choices.join(' | '),
    got: safeEnumLiteral(value),
  };
}

function safeEnumLiteral(value: string | undefined): string {
  if (value === undefined) return 'missing';
  const looksSensitive = /(?:^sk-|token|secret|password|bearer|private[-_]?key|api[-_]?key)/i.test(
    value,
  );
  return /^[A-Za-z0-9_-]{1,32}$/.test(value) && !looksSensitive ? value : safeRejectedString(value);
}

function safeRejectedString(value: string | undefined): string {
  return value === undefined ? 'missing' : `string (length ${value.length})`;
}

function safeFlagName(name: string): string {
  const value = `--${name}`;
  return /^[A-Za-z0-9-]{1,64}$/.test(name) ? value : safeRejectedString(value);
}

function safeShortFlag(value: string): string {
  return /^-[A-Za-z0-9-]{1,64}$/.test(value) ? value : safeRejectedString(value);
}

/** Parse + validate in one step — the pure surface unit tests exercise. */
export function buildFeedbackPayload(
  rest: readonly string[],
  diagnostics: FeedbackDiagnostics,
): FeedbackPayloadResult {
  const parsed = parseFeedbackArgs(rest);
  return parsed.ok ? validateFeedback(parsed.args, diagnostics) : parsed;
}

function invalidSubmission(error: FeedbackInputFailure): CliFailure {
  return {
    code: 'invalid_feedback',
    message: error.message,
    cause: 'The feedback submission did not pass local validation.',
    fix: 'Adjust the flags/message and rerun.',
    next: 'noodle feedback "what should we improve?" --type feat',
    errors: error.errors,
    exitCode: EXIT.USAGE,
  };
}

export async function runFeedback(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const wantsJson = rest.some((arg) => arg === '--json' || arg.startsWith('--json='));
  const parsedArgs = parseFeedbackArgs(rest);
  if (!parsedArgs.ok) {
    return printCliFailure('feedback', invalidSubmission(parsedArgs.error), wantsJson);
  }
  const args = parsedArgs.args;
  let message = args.message;
  if ((message === undefined || message.trim() === '') && !args.json && isInteractive()) {
    try {
      message = await text('What should we improve?', {
        validate: (v) => (v.trim() === '' ? 'a message is required' : undefined),
      });
    } catch (error) {
      if (error instanceof AbortPromptError) return EXIT.USAGE;
      throw error;
    }
  }
  const diagnostics = collectFeedbackDiagnostics();
  const built = validateFeedback(
    { ...args, ...(message !== undefined ? { message } : {}) },
    diagnostics,
  );
  if (!built.ok) return printCliFailure('feedback', invalidSubmission(built.error), args.json);

  if (args.dryRun) {
    const preview: FeedbackPreview = {
      mode: 'preview',
      willSubmit: false,
      destination: FEEDBACK_DESTINATION,
      submission: built.payload,
    };
    if (args.json) {
      printJsonOk(preview);
    } else {
      console.log('Feedback preview — Nothing was sent.');
      console.log(`Destination: ${preview.destination}`);
      console.log('Submission:');
      printRawJsonForHumanDebug(preview.submission, 2);
    }
    return EXIT.OK;
  }

  let resolved: Awaited<ReturnType<typeof resolveControlPlaneToken>>;
  try {
    resolved = await resolveControlPlaneToken({
      serviceFlag: args.service,
      authFlag: args.authToken,
      env,
      home,
    });
  } catch (error) {
    if (error instanceof RefreshTokenRejectedError) throw error;
    return printCliFailure('feedback', feedbackAuthResolutionFailure(), args.json);
  }
  if (resolved.token === undefined) {
    return printCliFailure('feedback', authRequired(), args.json);
  }

  if (!args.json) {
    const d = built.payload.diagnostics;
    console.log(
      `Attaching diagnostics: CLI ${d.cliVersion} · ${d.platform} · Node ${d.nodeVersion}`,
    );
  }
  try {
    const body = await serviceJson<FeedbackResponse>(
      `${resolved.serviceUrl}/v1/feedback`,
      resolved.token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(built.payload),
      },
    );
    if (args.json) {
      printJsonOk(body.data);
      return EXIT.OK;
    }
    console.log(
      `Feedback sent — reference ${body.data.reference} (labels: ${body.data.labels.join(', ')}). Thank you!`,
    );
    return EXIT.OK;
  } catch (error) {
    return printCliFailure('feedback', feedbackServiceFailure(error), args.json);
  }
}

function feedbackServiceFailure(error: unknown): CliFailure {
  const failure = serviceFailure('feedback', error, 'noodle feedback');
  const code =
    failure.code === 'auth_failed' ||
    failure.code === 'service_unreachable' ||
    failure.code === 'feedback_rate_limited' ||
    failure.code === 'feedback_unavailable' ||
    failure.code === 'feedback_recording_failed' ||
    failure.code === 'invalid_feedback' ||
    failure.code === 'client_version_unsupported'
      ? failure.code
      : failure.code === 'rate_limited'
        ? 'feedback_rate_limited'
        : failure.exitCode === EXIT.AUTH
          ? 'auth_failed'
          : 'feedback_recording_failed';

  if (code === 'client_version_unsupported') {
    const message = 'This Noodle CLI version is not supported by the feedback service.';
    return {
      code,
      message,
      cause: message,
      fix: 'Update the Noodle Seed CLI to a supported version.',
      next: 'noodle update',
      retryable: false,
      exitCode: failure.exitCode,
    };
  }

  if (code === 'feedback_recording_failed') {
    const message = 'Feedback recording outcome is unknown; the private issue may already exist.';
    return {
      code,
      message,
      cause: message,
      fix: 'Do not retry automatically; contact Noodle Seed support to confirm the outcome.',
      next: 'Wait for confirmation before submitting again.',
      retryable: false,
      exitCode: failure.exitCode,
    };
  }

  const recovery =
    code === 'auth_failed'
      ? {
          message: 'Feedback authentication failed.',
          fix: 'Sign in again and confirm the saved authentication profile.',
          next: 'noodle login',
          retryable: false,
        }
      : code === 'service_unreachable'
        ? {
            message: 'The feedback service could not be reached.',
            fix: 'Check the service URL and network connection.',
            next: 'Retry once connectivity is restored.',
            retryable: true,
          }
        : code === 'feedback_rate_limited'
          ? {
              message: 'Feedback rate limit reached; try again later.',
              fix: 'Wait for the rate-limit window to pass.',
              next: 'Retry once after the indicated delay.',
              retryable: true,
            }
          : code === 'feedback_unavailable'
            ? {
                message: 'The feedback service is unavailable.',
                fix: 'Wait until the feedback service is available.',
                next: 'Retry once after service recovery.',
                retryable: true,
              }
            : {
                message: 'The feedback service rejected the submission.',
                fix: 'Inspect the typed feedback fields and preview the corrected submission.',
                next: 'noodle feedback --dry-run --json',
                retryable: false,
              };
  return {
    code,
    message: recovery.message,
    cause: recovery.message,
    fix: recovery.fix,
    next: recovery.next,
    retryable: recovery.retryable,
    ...(failure.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: failure.retryAfterSeconds }
      : {}),
    exitCode: failure.exitCode,
  };
}

function feedbackAuthResolutionFailure(): CliFailure {
  const message = 'Feedback authentication could not be resolved.';
  return {
    code: 'auth_failed',
    message,
    cause: message,
    fix: 'Sign in again and confirm the saved authentication profile.',
    next: 'noodle login',
    retryable: false,
    exitCode: EXIT.AUTH,
  };
}
