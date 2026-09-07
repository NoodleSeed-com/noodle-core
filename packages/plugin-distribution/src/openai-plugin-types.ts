import type { HostPackageRequest } from '@noodle-borg/agent-packaging';

/** Explicit OpenAI distribution state; local registration never leaks into a public submission. */
export type OpenAiPluginOptions =
  | {
      readonly state: 'submission';
      readonly category: string;
    }
  | {
      readonly state: 'local';
      readonly category: string;
      /** Technical ID copied from the ChatGPT developer-mode registration URL. */
      readonly registeredAppId: string;
    };

export type OpenAiPluginRequest = HostPackageRequest;

export type NormalizedOpenAiPluginOptions =
  | { readonly state: 'submission'; readonly category: string }
  | {
      readonly state: 'local';
      readonly category: string;
      readonly registeredAppId: string;
    };
