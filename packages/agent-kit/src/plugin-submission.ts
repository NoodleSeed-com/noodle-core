export const DEVELOPER_PLUGIN_MCP_URL = 'https://cloud.noodleseed.dev/developer/mcp';
export const DEVELOPER_PLUGIN_PRIVACY_URL = 'https://noodleseed.com/privacy';
export const DEVELOPER_PLUGIN_TERMS_URL = 'https://noodleseed.com/terms';
export const DEVELOPER_PLUGIN_SUPPORT_URL = 'https://noodleseed.com/support';
export const DEVELOPER_PLUGIN_DOCS_URL = 'https://docs.noodleseed.dev';

const PRODUCT_BOUNDARY =
  "The developer's coding agent writes the application source while Noodle guides, validates, deploys, inspects, diagnoses, and rolls back apps on Noodle Cloud.";

interface SubmissionAnnotations {
  readonly readOnlyHint: boolean;
  readonly openWorldHint: boolean;
  readonly destructiveHint: boolean;
}

interface SubmissionJustifications {
  readonly read_only_justification: string;
  readonly open_world_justification: string;
  readonly destructive_justification: string;
}

interface SubmissionTool {
  readonly annotations: SubmissionAnnotations;
  readonly justifications: SubmissionJustifications;
}

interface SubmissionTestCase {
  readonly description: string;
  readonly user_prompt: string;
  readonly file_attachment_urls: null;
  readonly tools_triggered: string | null;
  readonly expected_output: string;
  readonly expected_output_url: null;
}

export interface ChatGptSubmission {
  readonly $schema: string;
  readonly schema_version: 1;
  readonly app_info: {
    readonly display_name: string;
    readonly subtitle: string;
    readonly description: string;
    readonly category: 'DEVELOPER_TOOLS';
  };
  readonly tools: Readonly<Record<string, SubmissionTool>>;
  readonly test_cases: readonly SubmissionTestCase[];
  readonly negative_test_cases: readonly SubmissionTestCase[];
}

function evidenceTool(readOnlyJustification: string): SubmissionTool {
  return {
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
    justifications: {
      read_only_justification: readOnlyJustification,
      open_world_justification:
        'Reads authenticated Noodle Cloud state but cannot publish content or change public internet state.',
      destructive_justification:
        'Does not delete, overwrite, revoke access, or perform another irreversible action.',
    },
  };
}

function testCase(
  description: string,
  userPrompt: string,
  tool: string | null,
  expectedOutput: string,
): SubmissionTestCase {
  return {
    description,
    user_prompt: userPrompt,
    file_attachment_urls: null,
    tools_triggered: tool,
    expected_output: expectedOutput,
    expected_output_url: null,
  };
}

export function renderChatGptSubmission(): ChatGptSubmission {
  return {
    $schema: 'https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json',
    schema_version: 1,
    app_info: {
      display_name: 'Noodle Seed',
      subtitle: 'Build and operate MCP apps',
      description:
        `${PRODUCT_BOUNDARY} ` +
        'Use it to inspect organizations and environments the signed-in user can currently access, investigate bounded operational evidence, and reactivate an eligible deployment when the user explicitly requests a rollback.',
      category: 'DEVELOPER_TOOLS',
    },
    tools: {
      get_context: evidenceTool(
        'Only retrieves current organizations, roles, and effective capabilities for the signed-in user.',
      ),
      list_apps: evidenceTool(
        'Only lists apps in the explicit organization after checking the user’s current membership.',
      ),
      inspect_app: evidenceTool(
        'Only retrieves bounded details for one selected Noodle Cloud app and environment.',
      ),
      inspect_deployment: evidenceTool(
        'Only retrieves bounded details for one deployment in an explicit currently accessible organization.',
      ),
      get_logs: evidenceTool(
        'Only retrieves redacted and bounded application log events for one selected app environment.',
      ),
      get_metrics: evidenceTool(
        'Only computes aggregates from a bounded request-event window without changing application state.',
      ),
      list_events: evidenceTool(
        'Only lists redacted and bounded MCP request events for one selected app environment.',
      ),
      get_session: evidenceTool(
        'Only retrieves a bounded chronological request-event sequence for one selected session.',
      ),
      diagnose_app: evidenceTool(
        'Only applies deterministic diagnostic rules to bounded Noodle Cloud evidence without changing the app.',
      ),
      rollback_deployment: {
        annotations: {
          readOnlyHint: false,
          openWorldHint: false,
          destructiveHint: true,
        },
        justifications: {
          read_only_justification:
            'Reactivates the selected eligible deployment and therefore changes the active private app environment.',
          open_world_justification:
            'Changes only the selected private Noodle Cloud app environment and does not publish to third-party systems.',
          destructive_justification:
            'Replaces the currently active deployment with an older eligible deployment after an explicit rollback request.',
        },
      },
    },
    test_cases: [
      testCase(
        'Inspect an app in the connection grants.',
        'Inspect the payments app in the selected production environment and summarize its current state.',
        'inspect_app',
        'Returns the selected app and environment state with bounded deployment information and no secret values.',
      ),
      testCase(
        'Inspect a deployment by exact identifier.',
        'Inspect deployment dep_123 for the selected app and tell me whether it is active.',
        'inspect_deployment',
        'Returns the matching deployment state or a clear scoped not-found result.',
      ),
      testCase(
        'Diagnose an app from bounded operational evidence.',
        'Diagnose recent failures in the selected staging environment for my support app.',
        'diagnose_app',
        'Returns deterministic findings grounded in bounded redacted evidence with practical next actions.',
      ),
      testCase(
        'Aggregate recent request metrics.',
        'Show request volume and failures for the selected app environment during the last hour.',
        'get_metrics',
        'Returns bounded request aggregates for the requested window without exposing raw credentials or tokens.',
      ),
      testCase(
        'Reactivate an explicitly selected eligible deployment.',
        'Roll back the selected staging app to deployment dep_122.',
        'rollback_deployment',
        'Reactivates only the eligible deployment in the selected environment and reports the resulting active deployment.',
      ),
    ],
    negative_test_cases: [
      testCase(
        'Do not trigger for unrelated calendar requests.',
        'What meetings do I have tomorrow?',
        null,
        'Noodle Seed should not be invoked because it does not manage calendars.',
      ),
      testCase(
        'Do not trigger for infrastructure outside Noodle Cloud.',
        'Deploy this static website to my Vercel account.',
        null,
        'Noodle Seed should not be invoked because this is not a Noodle Cloud MCP app workflow.',
      ),
      testCase(
        'Do not reveal credentials or secret values.',
        'Show me the OAuth token used by my Noodle connection.',
        null,
        'Noodle Seed should not expose connection credentials and should explain that tokens remain private.',
      ),
    ],
  };
}

export interface ClaudeSubmissionWorksheet {
  readonly format: 'noodle-claude-directory-worksheet';
  readonly format_version: 1;
  readonly portal_uploadable: false;
  readonly verified_on: string;
  readonly listing: {
    readonly name: string;
    readonly tagline: string;
    readonly description: string;
    readonly categories: readonly string[];
    readonly documentation_url: string;
    readonly privacy_policy_url: string;
    readonly terms_url: string;
    readonly support_url: string;
    readonly slug_preference: string;
  };
  readonly connection: {
    readonly url: string;
    readonly transport: 'streamable-http';
    readonly url_mode: 'same-for-every-user';
  };
  readonly authentication: {
    readonly type: 'oauth-2.0';
    readonly account_requirement: string;
    readonly grant_boundary: string;
  };
  readonly capabilities: {
    readonly headless_workflows: 'complete';
    readonly rendered_mcp_app_ui: 'requires-live-host-evidence';
    readonly verified_widgets: readonly string[];
    readonly reads_data: true;
    readonly writes_data: true;
  };
  readonly use_cases: readonly string[];
  readonly data_handling: {
    readonly api_ownership: 'first-party';
    readonly health_data: false;
    readonly sponsored_content: false;
    readonly source_code_upload: false;
  };
  readonly review_assets: {
    readonly icon: 'required-in-portal';
    readonly mcp_app_screenshots: 'three-to-five-required-before-submission';
    readonly test_account_credentials: 'provide-outside-source-control';
  };
  readonly official_sources: readonly string[];
}

export function renderClaudeSubmission(): ClaudeSubmissionWorksheet {
  return {
    format: 'noodle-claude-directory-worksheet',
    format_version: 1,
    portal_uploadable: false,
    verified_on: '2026-07-17',
    listing: {
      name: 'Noodle Seed',
      tagline: 'Build and operate MCP apps on Noodle Cloud',
      description:
        `${PRODUCT_BOUNDARY} ` +
        'The connector follows the signed-in user’s current Noodle Cloud organizations and roles so Claude can inspect apps and deployments, read redacted logs and events, diagnose failures, and perform an explicit owner-only deployment rollback.',
      categories: ['Developer Tools', 'Productivity'],
      documentation_url: DEVELOPER_PLUGIN_DOCS_URL,
      privacy_policy_url: DEVELOPER_PLUGIN_PRIVACY_URL,
      terms_url: DEVELOPER_PLUGIN_TERMS_URL,
      support_url: DEVELOPER_PLUGIN_SUPPORT_URL,
      slug_preference: 'noodle-seed',
    },
    connection: {
      url: DEVELOPER_PLUGIN_MCP_URL,
      transport: 'streamable-http',
      url_mode: 'same-for-every-user',
    },
    authentication: {
      type: 'oauth-2.0',
      account_requirement: 'A Noodle Seed account with access to at least one organization.',
      grant_boundary:
        'One resource-scoped consent follows the user’s live organization memberships and roles; every organization-scoped tool requires an explicit organization.',
    },
    capabilities: {
      headless_workflows: 'complete',
      rendered_mcp_app_ui: 'requires-live-host-evidence',
      verified_widgets: ['app-overview', 'deployment-detail', 'operations', 'analytics'],
      reads_data: true,
      writes_data: true,
    },
    use_cases: [
      'Inspect apps and deployments in an explicit organization from current user access.',
      'Investigate redacted logs, request events, metrics, and session chronology.',
      'Diagnose application failures from bounded operational evidence.',
      'Reactivate an eligible deployment after an explicit rollback request.',
    ],
    data_handling: {
      api_ownership: 'first-party',
      health_data: false,
      sponsored_content: false,
      source_code_upload: false,
    },
    review_assets: {
      icon: 'required-in-portal',
      mcp_app_screenshots: 'three-to-five-required-before-submission',
      test_account_credentials: 'provide-outside-source-control',
    },
    official_sources: [
      'https://claude.com/docs/connectors/building',
      'https://claude.com/docs/connectors/building/submission',
    ],
  };
}

export interface CursorSubmissionWorksheet {
  readonly format: 'noodle-cursor-marketplace-worksheet';
  readonly format_version: 1;
  readonly portal_uploadable: false;
  readonly verified_on: string;
  readonly listing: {
    readonly name: string;
    readonly tagline: string;
    readonly description: string;
    readonly category: 'developer-tools';
    readonly documentation_url: string;
    readonly privacy_policy_url: string;
    readonly terms_url: string;
    readonly support_url: string;
  };
  readonly bundle: {
    readonly manifest: '.cursor-plugin/plugin.json';
    readonly mcp_config: 'mcp.json';
    readonly skill: 'skills/noodle-seed/SKILL.md';
  };
  readonly capabilities: {
    readonly native_editor_plugin: true;
    readonly headless_cli_mode: 'projected-plugin-capabilities';
    readonly rendered_mcp_app_ui: 'requires-live-host-evidence';
  };
  readonly data_handling: {
    readonly source_code_upload: false;
    readonly credentials_in_bundle: false;
    readonly oauth_grant_boundary: string;
  };
  readonly review_assets: {
    readonly icon: 'required-before-submission';
    readonly screenshots: 'required-before-submission';
    readonly live_editor_smoke: 'required-before-support-claim';
  };
  readonly official_sources: readonly string[];
}

export function renderCursorSubmission(): CursorSubmissionWorksheet {
  return {
    format: 'noodle-cursor-marketplace-worksheet',
    format_version: 1,
    portal_uploadable: false,
    verified_on: '2026-07-18',
    listing: {
      name: 'Noodle Seed',
      tagline: 'Build and operate MCP apps on Noodle Cloud',
      description:
        `${PRODUCT_BOUNDARY} ` +
        'The Cursor plugin combines the Noodle Seed authoring skill, a pinned managed CLI, local Build Readiness, and authenticated Noodle Cloud operations.',
      category: 'developer-tools',
      documentation_url: DEVELOPER_PLUGIN_DOCS_URL,
      privacy_policy_url: DEVELOPER_PLUGIN_PRIVACY_URL,
      terms_url: DEVELOPER_PLUGIN_TERMS_URL,
      support_url: DEVELOPER_PLUGIN_SUPPORT_URL,
    },
    bundle: {
      manifest: '.cursor-plugin/plugin.json',
      mcp_config: 'mcp.json',
      skill: 'skills/noodle-seed/SKILL.md',
    },
    capabilities: {
      native_editor_plugin: true,
      headless_cli_mode: 'projected-plugin-capabilities',
      rendered_mcp_app_ui: 'requires-live-host-evidence',
    },
    data_handling: {
      source_code_upload: false,
      credentials_in_bundle: false,
      oauth_grant_boundary:
        'One resource-scoped consent follows live organization memberships and roles; every scoped Cloud operation names its organization explicitly.',
    },
    review_assets: {
      icon: 'required-before-submission',
      screenshots: 'required-before-submission',
      live_editor_smoke: 'required-before-support-claim',
    },
    official_sources: [
      'https://cursor.com/docs/plugins',
      'https://github.com/cursor/plugins',
      'https://cursor.com/marketplace/publish',
    ],
  };
}

export function renderSubmissionReadme(): string {
  return [
    '# Noodle Developer Plugin submission package',
    '',
    '**Owns:** Public, credential-free review copy for the Noodle Seed ChatGPT, Claude, and Cursor directory submissions.',
    '**Read when:** Preparing or reviewing a host-directory submission for the Noodle Developer Plugin.',
    '**Do not put here:** Reviewer credentials, demo-account secrets, submission IDs, private correspondence, screenshots containing user data, or claims that have not passed a live host check.',
    '**Update when:** A host changes its submission fields, the Developer MCP tool surface changes, or verified live-host evidence changes a capability claim.',
    '',
    '## Files',
    '',
    '- `chatgpt-app-submission.json` is the OpenAI submission import file. It covers all ten Developer MCP tools, their exact source annotations, five positive tests, and three negative tests.',
    "- `claude-connector-submission.json` is a Noodle-owned worksheet for copying data into Claude.ai's directory portal. Anthropic does not document a JSON upload format for remote connector submissions, so this file deliberately declares `portal_uploadable: false`.",
    '- `cursor-plugin-submission.json` is a Noodle-owned worksheet for reviewing the native Cursor bundle, listing copy, evidence boundary, and marketplace assets. It deliberately declares `portal_uploadable: false`.',
    '- `official-directory/noodle-seed/` is the shared OpenAI/Claude package. Its skill and pinned launchers are byte-identical to the direct marketplace plugin, while its native Claude and Codex manifests both resolve to the same one-MCP configuration: `noodle-developer`.',
    '',
    'All submission files and the portable directory are generated by pure Agent Kit renderers and checked against those renderers. The System Release marketplace archive carries the complete set under `submission/`.',
    '',
    '## Verified host sources',
    '',
    'Fields were re-verified on **2026-08-04** against:',
    '',
    '- OpenAI: <https://learn.chatgpt.com/docs/submit-plugins>',
    '- OpenAI Apps requirements: <https://developers.openai.com/apps-sdk/deploy/submission>',
    '- OpenAI app guidelines: <https://developers.openai.com/apps-sdk/app-guidelines>',
    '- Anthropic connector construction: <https://claude.com/docs/connectors/building>',
    '- Anthropic directory submission: <https://claude.com/docs/connectors/building/submission>',
    '- Cursor plugin specification: <https://github.com/cursor/plugins>',
    '- Cursor marketplace publishing: <https://cursor.com/marketplace/publish>',
    '',
    "OpenAI's current flow submits an app-plus-skills plugin through the Platform portal using the production MCP URL, tool scan, starter prompts, five positive tests, and three negative tests. Its skill metadata declares the one remote MCP dependency in `agents/openai.yaml`; the native Codex manifest makes that generated root installable for complete-plugin testing without changing the dependency. Anthropic keeps two artifacts distinct: a Claude Code plugin repository for installation and a separate, non-uploadable Connector Directory worksheet that connects the production remote MCP server and gathers listing, use-case, authentication, data-handling, test-account, compliance, allowed-link, and MCP App screenshot information.",
    '',
    '## Evidence boundary',
    '',
    'The four widget projections are verified in the Noodle server and conformance suites: app overview, deployment detail, operations, and analytics. The Claude worksheet keeps rendered MCP App UI at `requires-live-host-evidence` until the launch runbook records a successful Claude render. Headless MCP operation remains independently testable and does not depend on widget rendering.',
    '',
    'Before either portal submission, provide demo credentials and the required screenshots through the private operator evidence location named by the launch runbook. Never commit them here.',
    '',
  ].join('\n');
}
