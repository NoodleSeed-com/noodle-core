import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as one from '@noodleseed/one';
import * as platform from '@noodleseed/one/platform';
import * as react from '@noodleseed/one/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG } from '../src/commands/catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const repositoryRoot = join(packageRoot, '..', '..');
let consumerRoot = '';

const rootRuntimeKeys = [
  'BUILD_READINESS_SCHEMA_VERSION',
  'BUILD_RUN_STATUSES',
  'BUILD_STAGES',
  'CONVENTIONAL_ENTRYPOINTS',
  'DEFAULT_SERVICE_URL',
  'PluginModeError',
  'algolia',
  'annotations',
  'appendServer',
  'assertPluginCompatibility',
  'asset',
  'authenticatedWebsite',
  'bind',
  'clearConfig',
  'clientCredentials',
  'configPath',
  'connection',
  'connector',
  'customerAuth',
  'customerEndpoint',
  'deleteLocalConfigValue',
  'deploy',
  'dev',
  'embeddedAssistant',
  'externalExchange',
  'file',
  'firecrawl',
  'gmailConnector',
  'googleWorkloadIdentity',
  'handoffSession',
  'initProject',
  'isTerminalBuildRunStatus',
  'knowledge',
  'localConfigPath',
  'managedCollection',
  'managedSecret',
  'maskToken',
  'meilisearch',
  'noodleManaged',
  'noodlePlatform',
  'noodleProjectConfigPath',
  'openAICompatible',
  'parseBuildReadinessSnapshot',
  'projectConfigPath',
  'projectDeploymentPath',
  'prompt',
  'publicWebsite',
  'readConfig',
  'readLocalConfigValues',
  'readNoodleProjectConfig',
  'readPluginCompatibility',
  'readProjectDeployment',
  'readProjectLink',
  'readResolvedProjectConfig',
  'readServers',
  'relativeEntrypoint',
  'resolveAuthToken',
  'resolveConventionalEntrypoint',
  'resolveLinkedEntrypoint',
  'resolveLocalConfigValues',
  'resolveLocalEntrypoint',
  'resolvePluginMode',
  'resolveServiceUrl',
  'resource',
  'run',
  'secret',
  'server',
  'serversPath',
  'setLocalConfigValue',
  'site',
  'tavily',
  'tool',
  'transitionBuildRun',
  'validate',
  'variable',
  'when',
  'writeConfig',
  'writeNoodleProjectConfig',
  'writeProjectDeployment',
  'writeProjectLink',
  'z',
] as const;

const reactRuntimeKeys = [
  'Action',
  'ActionBar',
  'AppShell',
  'AsyncBoundary',
  'Avatar',
  'AvatarGroup',
  'Checkbox',
  'ChoiceGroup',
  'Collection',
  'DataCard',
  'DataList',
  'EmptyState',
  'ErrorState',
  'ExpandButton',
  'Fact',
  'Feedback',
  'Field',
  'Flow',
  'Form',
  'Frame',
  'FullscreenShell',
  'HandoffButton',
  'InlineCard',
  'InlineCarousel',
  'InlineList',
  'Input',
  'LoadingState',
  'Menu',
  'Overlay',
  'Popover',
  'QuantityStepper',
  'RadioGroup',
  'Region',
  'SegmentedControl',
  'Select',
  'ShellHeader',
  'ShellNav',
  'Slider',
  'Spinner',
  'StatusBadge',
  'SubmitButton',
  'Switch',
  'Textarea',
  'Tooltip',
  'View',
  'ViewNav',
  'ViewStack',
  'createViewStore',
  'generateHelpers',
  'useAppFlow',
  'useBranding',
  'useCallTool',
  'useHandoff',
  'useLayout',
  'useOpenExternal',
  'useRequestDisplayMode',
  'useSendFollowUpMessage',
  'useToolInfo',
  'useUpdateModelContext',
  'useViewState',
  'useWidgetLifecycle',
  'useWidgetReady',
] as const;

function activeCatalogPaths(): string[] {
  const paths: string[] = [];
  const visit = (node: (typeof CATALOG)[number], parents: readonly string[]): void => {
    const current = [...parents, node.name];
    paths.push(current.join(' '));
    for (const child of node.subcommands ?? []) visit(child, current);
  };
  for (const command of CATALOG) if (command.removed === undefined) visit(command, []);
  return paths;
}

beforeAll(async () => {
  consumerRoot = await mkdtemp(join(repositoryRoot, 'node_modules', '.public-package-contract-'));
});

afterAll(() => {
  if (consumerRoot !== '') rmSync(consumerRoot, { recursive: true, force: true });
});

describe('@noodleseed/one supported package contract', () => {
  it('keeps the compiler fixture ignored by repository scans', () => {
    const result = spawnSync('git', ['check-ignore', '--quiet', consumerRoot], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('keeps package metadata, bin, engines, and export-map entries exact', () => {
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    const golden = JSON.parse(
      readFileSync(join(repositoryRoot, 'contract/v1/noodleseed-one-package.json'), 'utf8'),
    ) as { readonly package: unknown };
    expect({
      name: packageJson.name,
      bin: packageJson.bin,
      engines: packageJson.engines,
      exports: packageJson.exports,
    }).toEqual(golden.package);
    expect(readFileSync(join(packageRoot, 'react/styles.css'), 'utf8').length).toBeGreaterThan(0);
  });

  it('keeps root, platform, and React runtime keys exact through the export map', () => {
    expect(Object.keys(one).sort()).toEqual(rootRuntimeKeys);
    expect(Object.keys(platform).sort()).toEqual(['noodlePlatform', 'noodlePlatformCatalog']);
    expect(Object.keys(react).sort()).toEqual(reactRuntimeKeys);
  });

  it('compiles representative public types from every JavaScript export entry', () => {
    const consumer = join(consumerRoot, 'consumer.ts');
    writeFileSync(
      consumer,
      [
        "import { server, type DevOptions, type NoodleConfig, type ServerDefinition } from '@noodleseed/one';",
        "import { noodlePlatform } from '@noodleseed/one/platform';",
        "import { generateHelpers, type AppShellProps } from '@noodleseed/one/react';",
        'type PublicTypes = [DevOptions, NoodleConfig, ServerDefinition, typeof noodlePlatform, AppShellProps];',
        'void (null as unknown as PublicTypes);',
        'void server;',
        'void noodlePlatform;',
        'void generateHelpers;',
      ].join('\n'),
    );
    const result = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, 'node_modules/typescript/bin/tsc'),
        '--ignoreConfig',
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        consumer,
      ],
      { cwd: packageRoot, encoding: 'utf8' },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it('keeps catalog identity, canonical order, and removed-command diagnostics exact', () => {
    const paths = activeCatalogPaths();
    const golden = JSON.parse(
      readFileSync(join(repositoryRoot, 'contract/v1/noodleseed-one-package.json'), 'utf8'),
    ) as {
      readonly catalog: {
        readonly topLevel: readonly string[];
        readonly activePaths: readonly string[];
        readonly removed: readonly unknown[];
      };
    };
    const removed = CATALOG.filter((command) => command.removed !== undefined).map(
      ({ name, removed: diagnostic }) => ({ name, removed: diagnostic }),
    );
    expect(CATALOG).toHaveLength(63);
    expect(paths).toHaveLength(328);
    expect(paths.filter((path) => path.startsWith('solutions operations'))).toEqual([
      'solutions operations',
      'solutions operations coordination',
      'solutions operations coordination list',
      'solutions operations coordination resolve',
    ]);
    expect(CATALOG.map(({ name }) => name)).toEqual(golden.catalog.topLevel);
    expect(paths).toEqual(golden.catalog.activePaths);
    expect(removed).toEqual(golden.catalog.removed);
  });
});
