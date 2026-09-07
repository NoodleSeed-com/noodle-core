import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { embedCheckCommand } from './assistant-embed-profile.js';
import type { EmbedFramework, EmbedSurface } from './assistant-embed-scaffold-template.js';

export interface EmbedFileAction {
  readonly path: string;
  readonly action: 'created' | 'unchanged' | 'skipped' | 'overwritten';
  readonly sha256: string;
  readonly content?: string;
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Inspect every fixed output before writing any of them; do not follow customer symlinks. */
export function prepareEmbedInstallation(
  dir: string,
  contents: Readonly<Record<string, string>>,
  options: { readonly force: boolean; readonly dryRun: boolean },
): readonly EmbedFileAction[] {
  assertEmbedOutputPaths(dir, Object.keys(contents));
  return Object.entries(contents).map(([path, content]) => {
    const full = join(dir, path);
    const existing = existsSync(full) ? readFileSync(full, 'utf8') : undefined;
    const action =
      existing === content
        ? 'unchanged'
        : existing === undefined
          ? 'created'
          : options.force
            ? 'overwritten'
            : 'skipped';
    return { path, action, sha256: hash(content), ...(options.dryRun ? { content } : {}) };
  });
}

/** Include instruction outputs in the same pre-write boundary as generated application files. */
export function assertEmbedOutputPaths(dir: string, paths: readonly string[]): void {
  for (const path of paths) {
    let current = dir;
    for (const segment of ['', ...path.split('/')]) {
      current = join(current, segment);
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error('assistant_embed_unsafe_path');
      }
    }
  }
}

export function applyEmbedInstallation(
  dir: string,
  contents: Readonly<Record<string, string>>,
  files: readonly EmbedFileAction[],
): void {
  assertEmbedOutputPaths(
    dir,
    files.map((file) => file.path),
  );
  for (const file of files) {
    if (file.action === 'unchanged' || file.action === 'skipped') continue;
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    const content = contents[file.path];
    if (content === undefined || hash(content) !== file.sha256) {
      throw new Error('assistant_embed_plan_changed');
    }
    writeFileSync(full, content, {
      flag: file.action === 'created' ? 'wx' : 'w',
    });
  }
}

/** Tool-facing recipe metadata describes installed assets, never a parallel authoring language. */
export function embedRecipe(
  framework: EmbedFramework,
  surface: EmbedSurface,
  files: readonly EmbedFileAction[],
) {
  return {
    id: `${framework}-${surface}`,
    version: 1,
    fingerprint: hash(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })))),
    appliesTo: [
      'Existing application with the requested website surface',
      'One canonical TypeScript Noodle application',
    ],
    doesNotApplyWhen: [
      'Native/mobile host',
      'No authorized access to the customer application',
      'Unresolved identity or tenant authorization',
    ],
    dependencies:
      framework === 'django-vue'
        ? ['@noodleseed/assistant', 'Django', 'requests', 'vue']
        : ['@noodleseed/assistant'],
    applicationSeams:
      surface === 'public'
        ? ['Public embed configuration', 'Application mount', 'Existing business operations']
        : [
            framework === 'django-vue'
              ? 'authenticate_assistant_request'
              : 'authenticateAssistantRequest',
            'Backend-owned tenant and permission mapping',
            ...(surface === 'mixed' ? ['Existing login transaction and signInTicket handoff'] : []),
            'Application mount',
            'Existing business operations',
          ],
    ownership:
      'Customer-owned source after installation; reruns preserve modified files unless --force is explicitly selected.',
    verification: [
      'Host build',
      'Application identity/tenant negative tests',
      'Representative sandbox workflow',
      'Browser turn and linked App',
    ],
  };
}

export function embedNextSteps(
  surface: EmbedSurface,
  framework: EmbedFramework = 'nextjs',
): readonly string[] {
  if (framework === 'django-vue')
    return [
      'Reuse the Django and Vue package managers; add requests and a compatible @noodleseed/assistant.',
      'Include noodle_assistant.urls and bind the server-only names in noodle_assistant/settings.example.py.',
      'Implement authenticate_assistant_request in noodle_assistant/auth.py using existing session and membership checks.',
      'Render src/components/NoodleAssistant.vue with principalKey and the existing application csrfToken.',
      'Keep normal Django CSRF middleware; route the session endpoint through the frontend origin.',
      'Run python manage.py test noodle_assistant, the generated frontend transport tests, and the existing Vue build.',
      'Run noodle assistant embed --framework django-vue --check --json with settings exported; finish the independent checks in NOODLE-INTEGRATION.md.',
      'Integration remains unverified until actual application identity, tenant and browser checks pass.',
    ];
  return [
    'Install a compatible @noodleseed/assistant version with the application package manager.',
    ...(surface === 'public'
      ? [
          'Set NEXT_PUBLIC_NOODLE_EMBED_ID and NEXT_PUBLIC_NOODLE_SERVICE_URL from the selected local or hosted deployment.',
        ]
      : [
          'Configure backend-only credentials from noodle assistant clients create for an explicitly authorized target.',
          'Implement authenticateAssistantRequest in lib/noodle-assistant-auth.ts using the existing session and membership checks.',
        ]),
    ...(surface === 'mixed'
      ? [
          'Bind onSignInRequested to the existing backend login transaction; verify signInTicket continuation.',
        ]
      : []),
    surface === 'public'
      ? 'Render AssistantWidget in the selected application layout.'
      : 'Render AssistantWidget with a stable user/tenant principalKey; change it on account changes (null for an anonymous mixed surface).',
    `Run ${embedCheckCommand(surface)} with the host environment exported, then the independent checks in NOODLE-INTEGRATION.md.`,
    'Application integration remains unverified until those checks run; installation does not authorize deployment or live writes.',
  ];
}
