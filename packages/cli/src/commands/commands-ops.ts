/**
 * `noodle commands [--json]` — the runtime capability catalog (roadmap item closed by this
 * module): a compact human list, or the full machine-readable `{ commands, exitCodes, version }`
 * payload every coding agent can query from the installed binary without reading source.
 */
import { currentCliVersion } from '../update.js';
import { buildCatalogJsonPayload, renderCommandsHuman } from './catalog-render.js';
import { EXIT, printJsonOk } from './output.js';

export function runCommands(rest: readonly string[]): number {
  const json = rest.includes('--json');
  const version = currentCliVersion();
  if (json) {
    printJsonOk(buildCatalogJsonPayload(version));
    return EXIT.OK;
  }
  console.log(renderCommandsHuman());
  return EXIT.OK;
}
