import type { ApplicationConnectionsOptions } from './application-connections.js';
import type { SolutionInstallation } from './business-information/contracts.js';
import type { SourceCredentialAuthority } from './business-information/source-credential-fence.js';
import { SourceCredentialError } from './business-information/source-credential-fence.js';
import type { PortableConnections } from './connections/service.js';
import type { ConnectionTarget } from './connections/types.js';
import { ConnectionError } from './connections/types.js';

/** Local portable account identity only; managed secrets and independently selected remote brokers stay valid. */
export function sourceCredentialAuthority(
  options: ApplicationConnectionsOptions,
  connections: PortableConnections,
  targets: (installation: SolutionInstallation) => Promise<readonly ConnectionTarget[]>,
): SourceCredentialAuthority {
  return {
    async withCurrent(binding, work) {
      const installation = await options.installations.getInstallation(binding.scope);
      const target =
        installation &&
        (await targets(installation)).find(
          (value) => value.key.connectionId === binding.bindingReference,
        );
      const provider = target && (await options.providers(target.key));
      if (!provider) return work(undefined);
      if (target.connectionConfigRevision !== binding.configurationReference)
        throw new SourceCredentialError();
      try {
        return await connections.withAccountIdentity(target, work);
      } catch (error) {
        if (error instanceof ConnectionError) throw new SourceCredentialError();
        throw error;
      }
    },
  };
}
