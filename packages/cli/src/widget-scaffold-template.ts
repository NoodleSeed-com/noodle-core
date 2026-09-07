/** The widget starter is a focused production baseline; the full gallery stays an internal fixture. */
import type { ProjectAgentTarget } from './project.js';
import { commonFiles, manifestName, title } from './project-scaffold-templates.js';
import { widgetFocusedHelpers, widgetFocusedView } from './widget-focused-template.js';

export function widgetFiles(
  name: string,
  agentTargets: readonly ProjectAgentTarget[],
  profile: 'widget' | 'saas' = 'widget',
): Record<string, string> {
  const embedded = profile === 'saas';
  const serverName = manifestName(name);
  const files = commonFiles(
    name,
    profile,
    agentTargets,
    `import {
  annotations,
${embedded ? '  authenticatedWebsite,\n  embeddedAssistant,\n  noodleManaged,\n  variable,\n' : ''}
  prompt,
  resource,
  server,
  tool,
  z,
} from '@noodleseed/one';

const preferences = z.object({
  channel: z.enum(['email', 'sms']),
  summary: z.string(),
  demo: z.literal(true),
});

export default server('${serverName}', {
  title: '${title(name)}',
  version: '1.0.0',
  instructions: 'Demonstrate workspace reads and preference previews. All data is synthetic; no customer changes are saved.',
${
  embedded
    ? `  // IDENTITY SEAM: the existing application backend verifies the user before session exchange.
  // No fabricated issuer and no caller-controlled identity. Keep direct MCP access owner-only until
  // you explicitly add a reviewed customerAuth recipe for direct clients.
  assistant: embeddedAssistant({
    model: noodleManaged(),
    access: [authenticatedWebsite({ origins: [variable('ASSISTANT_ORIGIN')] })],
  }),
`
    : ''
}
  branding: {
    name: '${title(name)}',
    accent: '#1D9E75',
    radius: 'md',
    density: 'comfortable',
  },
  // No handoff tool or external destination is enabled in this synthetic baseline.
  state: {
    handles: {
      workspace_draft: {
        kind: 'draft',
        scope: 'caller',
        version: '1',
        ttlSeconds: 86400,
        schema: z.object({ note: z.string(), updatedAt: z.string() }),
      },
    },
  },
}, [
  tool('list_workspace_items', {
    title: 'List workspace items',
    description: 'List the current workspace items with concise status summaries.',
${embedded ? '    contextProvider: true,\n' : ''}
    annotations: annotations.readOnly(),
    input: z.object({}).strict(),
    output: z.object({ items: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })) }),
    fulfil: () => ({ items: [
      { id: 'item-1', title: 'Review the synthetic starter', status: 'active' },
      { id: 'item-2', title: 'Connect a real customer API', status: 'active' },
    ] }),
  }),
  tool('show_preferences', {
    title: 'Show notification preferences',
    description: 'Show the current notification preference in a focused widget.',
    annotations: annotations.readOnly(),
    input: z.object({}).strict(),
    output: preferences,
    fulfil: () => ({
      channel: 'email',
      summary: 'Demo preference: email. No customer data is loaded.',
      demo: true,
    }),
    viewTitle: 'Notification preferences',
    viewDescription: 'Preview one synthetic notification preference; nothing is saved.',
    invoking: 'Loading preferences…',
    invoked: 'Preferences ready',
${embedded ? '' : "    // Optional host compatibility metadata. Replace before public host distribution.\n    domain: 'https://your-app.example.com',\n"}
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
    },
    view: {
      component: 'preferences-card',
      entry: './views/preferences-card.tsx',
    },
  }),
  tool('save_preferences', {
    description: 'Preview a synthetic preference selected in the widget. This does not save customer data.',
    annotations: annotations.localAction({ destructive: false, confirm: false }),
    visibility: ['app'],
    input: z.object({
      channel: z.enum(['email', 'sms']),
    }).strict(),
    output: preferences,
    fulfil: ({ input }) => ({
      channel: input.channel,
      summary: \`Preview: \${input.channel}; not saved. Connect your authorized backend before enabling real writes.\`,
      demo: true,
    }),
  }),
  resource('workspace_guide', {
    uri: 'docs://workspace/guide',
    title: 'Workspace guide',
    description: 'Grounding information for the generated production starter.',
    mimeType: 'text/markdown',
    fulfil: () => '# Workspace guide\\n\\nThis starter demonstrates tools, resources, prompts, a widget, state, and handoff.',
  }),
  prompt('plan_next_step', {
    title: 'Plan the next workspace step',
    description: 'Prepare a grounded, human-reviewable next-step plan.',
    arguments: z.object({ goal: z.string().default('Ship the first customer integration') }),
    fulfil: ({ input }) => ({ messages: [{ role: 'user', content: { type: 'text', text: \`Plan the safest next step for: \${input.goal}\` } }] }),
  }),
]);
`,
    ['@types/react', '@types/react-dom', '@vitejs/plugin-react', 'react', 'react-dom', 'vite'],
  );

  return {
    ...files,
    'src/vite-env.d.ts': '/// <reference types="vite/client" />\n',
    'src/helpers.ts': widgetFocusedHelpers,
    'src/views/preferences-card.tsx': widgetFocusedView,
    'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,
    'README.md': `# ${title(name)}

## Run locally (no account or login)

\`\`\`sh
npm run agent:check
\`\`\`

Init installed pinned project-local tooling and ran these checks unless you chose \`--no-install\`.
Resume files-only or failed setup with its reported command; do not use \`--force\` to repair customer code.
Replace \`npm run\` with \`pnpm run\` / \`yarn run\` when that is the selected manager.
\`npm test\` compiles the actual source and widget, lists tools, checks a synthetic read and rejects invalid
input. It uses temporary source/configuration and never copies your credentials. Use your existing package
manager consistently. Bind the declared names for your application, then use \`npm run dev\` for hot reload,
\`noodle devtools\` for a widget preview and \`npm run agent:check\` for local readiness findings.

## Widget authoring

This is a tested integration baseline with explicitly synthetic data. It ships model-visible and app-only
tools, a resource, prompt, caller-scoped state contract, and branded widget. The widget itself
keeps one purpose and one primary action, with safe prefilling and explicit loading, empty, error, retry, and success states.

- \`tool(..., { view })\` links the model-visible tool to the React view.
- \`tool(..., { visibility: ['app'] })\` powers the widget's explicit synthetic preview action.
- \`view.component\` links the tool to a React view in \`src/views/\`.
- \`useLayout()\` adapts to MCP Apps host context without requiring a host-specific global.
- Keep inline widgets to one primary action and at most one subordinate action; use progressive disclosure
  instead of nested navigation or scrolling.
- Optional host extensions should always be feature-detected and must not be required for baseline use.

## Deploy (requires a Noodle Seed account)

\`\`\`sh
noodle login
noodle deploy --org <org> --app ${name}
\`\`\`

The generated tests run locally without login, using isolated configuration and synthetic data. They do not
prove a customer integration. Keep the default owner-only direct MCP access. Do not enable public access
to private business capabilities; add the reviewed customer-auth recipe first. No handoff destinations are
allowed until you declare the approved destinations. Replace any optional host domain before distribution.

## Your edit seams

Change business input/output schemas and fulfillment in \`src/server.ts\`, layout in
\`src/views/preferences-card.tsx\`, and representative assertions in \`test/server.test.ts\`. The preview
returns \`demo: true\` and never saves; when connecting real writes, replace the synthetic mapping with the
authorized backend connector and require confirmation. Prove the backend change before displaying success.
Operator bindings use \`noodle variables\` / \`noodle secrets\`, not source edits. Preserve the generated
guard and test infrastructure; rerunning init preserves modified files and creates missing files.

${
  embedded
    ? `## Embedded customer application

The SaaS default declares an authenticated website assistant with a managed model. It does not require a
new customer identity provider or a model-provider key. Bind \`ASSISTANT_ORIGIN\` to the exact website
origin using \`noodle variables set\` for the intended target; the local test binds only its isolated fixture.
For local use, export the reviewed origin and run
\`noodle variables set ASSISTANT_ORIGIN --runtime local --scope env --org local --app ${name} --env dev --from-env ASSISTANT_ORIGIN\`.
Hosted model execution and session exchange still require a configured, authorized deployment.

In your existing application, run \`noodle assistant embed --framework nextjs --surface authenticated\`
(or \`--framework django-vue\`). This installs the maintained session handler, browser mount, tests and
\`NOODLE-INTEGRATION.md\`; it does not create a second website or login system. Implement only
\`authenticateAssistantRequest\` using verified backend login and membership. Keep exchange credentials
server-only. Follow the installed guide for origin, tenant, browser and real-backend verification.

Direct customer MCP access is a separate explicit \`customerAuth\` recipe on this same server; the shipped
Agent Kit owns issuer discovery and delegatedTokenExchange guidance. Local demo tests are not auth proof.
`
    : `
## Optional embedded assistant

The default scaffold is credential-free. Add \`assistant: embeddedAssistant(...)\` to \`server.ts\` only
when the product deliberately includes a customer-hosted assistant. This explicit TypeScript opt-in keeps
ordinary ChatGPT, Claude, and other MCP-hosted widgets independent of model-provider settings. The installed
Noodle Agent Kit's \`references/embedded-assistant.md\` owns the complete configuration and verification
workflow.
`
}

## Agent setup

\`noodle init\` generated project-local Codex and Claude Code instructions. Commit those files with
\`noodle.json\`, and refresh them after CLI upgrades with \`noodle agents setup --write\`.
`,
  };
}
