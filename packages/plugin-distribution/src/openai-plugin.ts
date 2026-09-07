import {
  type HostPackageAdapter,
  type HostPackageRequest,
  type HostPackageResult,
  packageHostTarget,
} from '@noodle-borg/agent-packaging';
import { renderOpenAiPlugin } from './openai-plugin-render.js';
import type { OpenAiPluginOptions } from './openai-plugin-types.js';
import {
  validateOpenAiPluginInput,
  validateOpenAiPluginOptions,
} from './openai-plugin-validation.js';

export const OPENAI_PLUGIN_ADAPTER_VERSION = '1.0.0';

/** Render one explicit OpenAI local-testing or public-submission projection. */
export function packageOpenAiPlugin(
  request: HostPackageRequest,
  options: OpenAiPluginOptions,
): HostPackageResult {
  const validatedOptions = validateOpenAiPluginOptions(options);
  const adapter: HostPackageAdapter = {
    target: 'openai',
    version: OPENAI_PLUGIN_ADAPTER_VERSION,
    validate: (input) => [
      ...validatedOptions.issues,
      ...validateOpenAiPluginInput(input, validatedOptions.options),
    ],
    render: (input) => {
      if (validatedOptions.options === undefined) {
        throw new Error('OpenAI options were not validated');
      }
      return renderOpenAiPlugin(input, validatedOptions.options);
    },
  };
  return packageHostTarget(request, adapter);
}

export type * from './openai-plugin-types.js';
