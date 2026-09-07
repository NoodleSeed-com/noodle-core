/**
 * The `POST /v1/feedback` wire contract (ADR 0166): developer/product feedback submitted by the
 * CLI (`noodle feedback`, often driven by the customer's coding agent) and filed by the service as
 * a labeled issue in the private feedback repo. Both sides parse with these schemas: the CLI
 * validates before sending, the service re-validates as untrusted input. The GitHub label set is
 * constructed server-side from validated fields only — callers can never inject label strings.
 */
import { z } from 'zod';

/**
 * `area:*` slugs a feedback submission may target — mirrors the canonical label taxonomy in
 * `scripts/github-labels-sync.mjs`.
 */
export const FEEDBACK_AREAS = [
  'docs',
  'analytics',
  'connectors',
  'self-service',
  'conformance',
  'ci',
  'deploys',
  'distribution',
  'console',
  'dx',
  'plugins',
  'cli',
  'compiler',
  'multi-surface',
  'enterprise',
  'policy',
] as const;

/** Conventional-commit-shaped feedback types, mirroring the `type:*` labels. */
export const FEEDBACK_TYPES = ['fix', 'feat', 'docs', 'chore'] as const;

/** Priority labels `P0`–`P3`. */
export const FEEDBACK_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const;

export const FEEDBACK_MESSAGE_MIN = 1;
export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_TITLE_MIN = 1;
export const FEEDBACK_TITLE_MAX = 120;
export const FEEDBACK_AGENT_NAME_MIN = 1;
export const FEEDBACK_AGENT_NAME_MAX = 64;
export const FEEDBACK_AGENT_MODEL_MIN = 1;
export const FEEDBACK_AGENT_MODEL_MAX = 64;
export const FEEDBACK_TYPE_DEFAULT = 'feat';
export const FEEDBACK_SEVERITY_DEFAULT = 'P3';

const feedbackAgentValue = (minimum: number, maximum: number) =>
  z
    .string()
    .regex(/^[^\r\n]+$/, 'must be one line')
    .trim()
    .min(minimum)
    .max(maximum);

/** The `POST /v1/feedback` request body. Untrusted input: strict, clamped, enum-allowlisted. */
export const FeedbackSubmissionSchema = z
  .object({
    message: z.string().trim().min(FEEDBACK_MESSAGE_MIN).max(FEEDBACK_MESSAGE_MAX),
    title: z.string().trim().min(FEEDBACK_TITLE_MIN).max(FEEDBACK_TITLE_MAX).optional(),
    type: z.enum(FEEDBACK_TYPES).default(FEEDBACK_TYPE_DEFAULT),
    severity: z
      .string()
      .transform((value) => value.toUpperCase())
      .pipe(z.enum(FEEDBACK_SEVERITIES))
      .default(FEEDBACK_SEVERITY_DEFAULT),
    area: z.enum(FEEDBACK_AREAS).optional(),
    codingAgent: z
      .object({
        name: feedbackAgentValue(FEEDBACK_AGENT_NAME_MIN, FEEDBACK_AGENT_NAME_MAX),
        model: feedbackAgentValue(FEEDBACK_AGENT_MODEL_MIN, FEEDBACK_AGENT_MODEL_MAX).optional(),
      })
      .strict()
      .optional(),
    diagnostics: z
      .object({
        cliVersion: z.string().max(64).optional(),
        platform: z.string().max(64).optional(),
        nodeVersion: z.string().max(64).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type FeedbackSubmission = z.infer<typeof FeedbackSubmissionSchema>;

/** The full `POST /v1/feedback` response body. The private issue URL is never exposed to callers. */
export const FeedbackResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        reference: z.string(),
        labels: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export type FeedbackResponse = z.infer<typeof FeedbackResponseSchema>;

/** Stable service-owned failure codes for `POST /v1/feedback`. */
export const FEEDBACK_ERROR_CODES = [
  'invalid_feedback',
  'feedback_rate_limited',
  'feedback_unavailable',
  'feedback_recording_failed',
] as const;

/** A structured feedback failure returned by the hosted service. */
export const FeedbackErrorResponseSchema = z
  .object({
    error: z.string(),
    code: z.enum(FEEDBACK_ERROR_CODES),
  })
  .strict();

export type FeedbackErrorResponse = z.infer<typeof FeedbackErrorResponseSchema>;
