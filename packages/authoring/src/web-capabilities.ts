import {
  type WebCapability,
  type WebPolicy,
  webCapabilityBaseSchema,
} from '@noodle-borg/managed-capabilities';
import type { NoodleManagedModel } from './assistant.js';
import type { ToolAuthorizationOptions } from './server.js';

export interface WebExtractOptions {
  readonly title: string;
  readonly description: string;
  readonly provider: NoodleManagedModel;
  readonly policy?: WebPolicy;
  readonly authorization?: ToolAuthorizationOptions;
}
export type WebExtractDeclaration = WebCapability & { readonly kind: 'web-extract' };

/** Read explicit public pages through the platform's governed extraction capability. */
export function webExtract(name: string, options: WebExtractOptions): WebExtractDeclaration {
  const { authorization, ...base } = options;
  return {
    kind: 'web-extract',
    ...webCapabilityBaseSchema.parse({ name, class: 'web.extract.v1', ...base }),
    ...(authorization === undefined ? {} : { authorization: structuredClone(authorization) }),
  };
}

export function manifestWebCapability(value: WebExtractDeclaration): WebCapability {
  const { kind: _kind, ...declaration } = value;
  return structuredClone(declaration);
}
