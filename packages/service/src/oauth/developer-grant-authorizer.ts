import { capabilitiesForDeveloperResource, isDeveloperResource } from '@noodle-borg/developer-mcp';

import type { DeveloperAccessGrant, DeveloperGrantStore } from './developer-grant.js';

export interface DeveloperGrantIdentityInput {
  readonly clientId: string;
  readonly subject: string;
  readonly resource: string;
}

export interface DeveloperGrantAuthorizerOptions {
  readonly grants: DeveloperGrantStore;
}

export class DeveloperGrantAuthorizer {
  readonly #grants: DeveloperGrantStore;

  constructor(options: DeveloperGrantAuthorizerOptions) {
    this.#grants = options.grants;
  }

  async findActive(input: DeveloperGrantIdentityInput): Promise<DeveloperAccessGrant | undefined> {
    if (!isDeveloperResource(input.resource)) return undefined;
    return this.#grants.getActive(input);
  }

  async authorize(input: DeveloperGrantIdentityInput): Promise<DeveloperAccessGrant> {
    if (!isDeveloperResource(input.resource)) throw new Error('invalid developer resource');
    const capabilities = capabilitiesForDeveloperResource(input.resource);
    if (capabilities.length === 0)
      throw new Error('developer resource has no available capabilities');
    return this.#grants.getOrCreateActive({ ...input, capabilities });
  }

  /** Revoke only the exact grant carried by a verified subject/client token. */
  async revoke(input: {
    readonly id: string;
    readonly clientId: string;
    readonly subject: string;
    readonly at: string;
  }): Promise<DeveloperAccessGrant | undefined> {
    const grant = await this.#grants.get(input.id);
    if (
      grant === undefined ||
      grant.clientId !== input.clientId ||
      grant.subject !== input.subject
    ) {
      return undefined;
    }
    return this.#grants.revoke(input.id, input.at);
  }
}
