import {
  type CompatibilityHost,
  featureRegistryMarkdown,
  PRODUCT_FEATURES,
} from '@noodle-borg/capabilities';
import { FEATURE_HOST_CHOICES } from './catalog-data-core.js';
import { EXIT, printJsonFailure, printJsonOk } from './output.js';

function isFeatureHost(value: string): value is CompatibilityHost {
  return FEATURE_HOST_CHOICES.some((choice) => choice === value);
}

export function runFeatures(rest: readonly string[]): number {
  const json = rest.includes('--json');
  const markdown = rest.includes('--markdown');
  const hostIndex = rest.indexOf('--host');
  const host = hostIndex === -1 ? undefined : rest[hostIndex + 1];
  if (host !== undefined && !isFeatureHost(host)) {
    const choices = `${FEATURE_HOST_CHOICES.slice(0, -1).join(', ')}, or ${FEATURE_HOST_CHOICES.at(-1)}`;
    if (json) {
      return printJsonFailure(
        {
          code: 'invalid_host',
          message: `features: --host must be ${choices}`,
          fix: 'Choose a supported compatibility host.',
          next: `noodle features --host <${FEATURE_HOST_CHOICES.join('|')}> --json`,
        },
        EXIT.USAGE,
      );
    }
    console.error(`features: --host must be ${choices}`);
    return EXIT.USAGE;
  }
  const features =
    host === undefined
      ? PRODUCT_FEATURES
      : PRODUCT_FEATURES.filter((feature) => feature.hosts[host] !== 'unsupported');
  if (json) printJsonOk({ features });
  else if (markdown) console.log(featureRegistryMarkdown(features));
  else {
    for (const feature of features) {
      console.log(
        `${feature.id.padEnd(28)} claude=${feature.hosts.claude} chatgpt=${feature.hosts.chatgpt} embedded=${feature.hosts.embedded}`,
      );
    }
  }
  return 0;
}
