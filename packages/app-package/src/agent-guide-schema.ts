import { z } from 'zod';
import {
  APP_PACKAGE_V1_MAX_BOUNDARIES,
  APP_PACKAGE_V1_MAX_EXAMPLES,
  APP_PACKAGE_V1_MAX_IDENTIFIER_CHARS,
  APP_PACKAGE_V1_MAX_PROSE_CHARS,
  APP_PACKAGE_V1_MAX_USE_WHEN,
  APP_PACKAGE_V1_MAX_WORKFLOW_STEPS,
  APP_PACKAGE_V1_MAX_WORKFLOWS,
} from './limits.js';

export const AGENT_GUIDE_MAX_USE_WHEN = APP_PACKAGE_V1_MAX_USE_WHEN;
export const AGENT_GUIDE_MAX_WORKFLOWS = APP_PACKAGE_V1_MAX_WORKFLOWS;
export const AGENT_GUIDE_MAX_STEPS = APP_PACKAGE_V1_MAX_WORKFLOW_STEPS;
export const AGENT_GUIDE_MAX_BOUNDARIES = APP_PACKAGE_V1_MAX_BOUNDARIES;
export const AGENT_GUIDE_MAX_EXAMPLES = APP_PACKAGE_V1_MAX_EXAMPLES;
export const AGENT_GUIDE_MAX_PROSE = APP_PACKAGE_V1_MAX_PROSE_CHARS;

const agentGuideNameSchema = z
  .string()
  .max(APP_PACKAGE_V1_MAX_IDENTIFIER_CHARS)
  .regex(/^[a-z0-9_]+$/, 'must use lowercase letters, numbers, and underscores');
const proseSchema = z.string().trim().min(1).max(AGENT_GUIDE_MAX_PROSE);

const capabilitySchema = z
  .object({
    kind: z.enum(['tool', 'resource', 'prompt']),
    name: agentGuideNameSchema,
  })
  .strict();

const workflowStepSchema = z
  .object({
    capability: capabilitySchema,
    guidance: proseSchema.optional(),
  })
  .strict();

const workflowSchema = z
  .object({
    id: agentGuideNameSchema,
    title: proseSchema,
    intent: proseSchema.optional(),
    steps: z.array(workflowStepSchema).min(1).max(AGENT_GUIDE_MAX_STEPS).readonly(),
  })
  .strict();

const exampleSchema = z
  .object({
    prompt: proseSchema,
    workflow: agentGuideNameSchema,
  })
  .strict();

/** Strict, internal Core-v2 transport for one product-level agent guide. */
export const agentGuideSchema = z
  .object({
    description: proseSchema,
    useWhen: z.array(proseSchema).min(1).max(AGENT_GUIDE_MAX_USE_WHEN).readonly(),
    workflows: z.array(workflowSchema).min(1).max(AGENT_GUIDE_MAX_WORKFLOWS).readonly(),
    boundaries: z.array(proseSchema).max(AGENT_GUIDE_MAX_BOUNDARIES).readonly().optional(),
    examples: z.array(exampleSchema).max(AGENT_GUIDE_MAX_EXAMPLES).readonly().optional(),
  })
  .strict();
