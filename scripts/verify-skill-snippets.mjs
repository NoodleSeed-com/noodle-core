#!/usr/bin/env node
// Snippet-compile gate (B6) + cold-agent E2E (A10) for the shipped `noodle-seed` skill.
//
// Why this exists: the skill's authoring recipes live as fenced ```ts / ```tsx blocks inside the
// generated skill references (`references/sdk-surface.md`, `widgets-and-apps.md`,
// `authoring-workflow.md`, `examples.md`). If a builder signature or compile rule changes, those
// recipes can silently rot. This gate scaffolds a throwaway project with the *built* CLI, reads the
// on-disk references it wrote, and validates every full-server recipe through the REAL compiler
// (`noodle validate --json`) — never raw `tsc`, because the symbolic connector/widget recording proxy
// has no index signature, exactly like the flagship examples.
//
// It also drives the cold-agent loop (A10): assert the scaffolded agent context advertises the
// `--json` contract, author a deliberately broken server, watch `noodle validate --json` cite the
// error `code` + `path`, apply the obvious fix, and confirm `noodle validate`/`noodle test` go green.
//
// Deterministic, offline, no account. Requires the CLI dist to be built first:
//   pnpm --filter "@noodleseed/one..." build
//
// Registered in scripts/README.md (agent-facing) as `pnpm verify:skill-snippets`.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLI_BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
const CLI_PKG_JSON = join(ROOT, 'packages', 'cli', 'package.json');
const NODE = process.execPath;

// The reference tree the skill installs under (claude-code target). We read the files the CLI itself
// wrote, so the gate checks the shipped bytes, not the renderer source.
const REFERENCES_SUBDIR = join('.claude', 'skills', 'noodle-seed', 'references');
const AGENTS_FILE = 'AGENTS.md';
const SKILL_FILE = join('.claude', 'skills', 'noodle-seed', 'SKILL.md');

// Strings the cold agent relies on to drive the loop from the scaffolded project.
const REQUIRED_CONTEXT_STRINGS = [
  'noodle commands --json',
  'noodle validate --json',
  'references/agent-contract.md',
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  const error = new Error(message);
  error.expected = true;
  throw error;
}

function runCli(args, cwd) {
  const result = spawnSync(NODE, [CLI_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, HOME: join(cwd, '.test-home'), NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  if (result.error) fail(`\`noodle ${args.join(' ')}\` could not spawn: ${result.error.message}`);
  return result;
}

// The `--json` commands print a single JSON envelope. Parse the whole output, or fall back to the
// last `{...}` line if the command also emitted incidental log lines.
function parseEnvelope(stdout) {
  const text = (stdout ?? '').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split('\n').map((line) => line.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].startsWith('{')) {
        try {
          return JSON.parse(lines[i]);
        } catch {
          // keep scanning older lines
        }
      }
    }
  }
  return undefined;
}

function extractBlocks(markdown) {
  const fence = /```(tsx?)\n([\s\S]*?)```/g;
  const blocks = [];
  let match = fence.exec(markdown);
  while (match) {
    blocks.push({ lang: match[1], code: match[2] });
    match = fence.exec(markdown);
  }
  return blocks;
}

const isFullServer = (code) => code.includes('export default server(');

function viewEntries(code) {
  return [...code.matchAll(/entry:\s*['"]([^'"]+\.tsx?)['"]/g)].map((m) => m[1]);
}

// Locate the workspace `vite` package (needed only to bundle widget views). Resolved from the CLI's
// own package so it survives pnpm's hashed store paths. Absent in a minimal env → widget-bundling
// snippets are skipped loudly rather than failing spuriously.
function resolveViteDir() {
  try {
    return dirname(createRequire(CLI_PKG_JSON).resolve('vite/package.json'));
  } catch {
    return undefined;
  }
}

function scaffoldProject(root) {
  const projectDir = join(root, 'proj');
  mkdirSync(projectDir, { recursive: true });
  const init = runCli(
    ['init', '--template', 'hello', '--name', 'skillsnip', '--agents', 'all', '--no-docs-mcp'],
    projectDir,
  );
  if (init.status !== 0) {
    fail(`noodle init failed (exit ${init.status}):\n${init.stdout}\n${init.stderr}`);
  }
  return projectDir;
}

function resetSrc(projectDir) {
  const srcDir = join(projectDir, 'src');
  rmSync(srcDir, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  return srcDir;
}

function writeServer(projectDir, code) {
  writeFileSync(join(projectDir, 'src', 'server.ts'), code);
}

// ---------------------------------------------------------------------------
// B6 — validate every full-server recipe through the real compiler.
// ---------------------------------------------------------------------------
function runSnippetGate(projectDir, viteAvailable) {
  const referencesDir = join(projectDir, REFERENCES_SUBDIR);
  if (!existsSync(referencesDir)) fail(`scaffold missing skill references at ${referencesDir}`);

  const summary = { validated: 0, skippedFragments: 0, skippedWidgetsNoVite: 0, byReference: {} };
  const referenceFiles = readdirSync(referencesDir)
    .filter((name) => name.endsWith('.md'))
    .sort();

  log('── B6 snippet-compile gate ──');
  for (const file of referenceFiles) {
    const blocks = extractBlocks(readFileSync(join(referencesDir, file), 'utf8'));
    if (blocks.length === 0) continue;

    // Views (non-full-server blocks) are the raw material for any `entry:` a full-server block
    // references. Pair them in document order within the file.
    const fragments = blocks.filter((b) => !isFullServer(b.code));
    const fullBlocks = blocks.filter((b) => isFullServer(b.code));
    const stats = { validated: 0, skippedFragments: 0, skippedWidgetsNoVite: 0 };

    for (let index = 0; index < fragments.length; index += 1) {
      stats.skippedFragments += 1;
      summary.skippedFragments += 1;
      log(`  SKIP  ${file} fragment #${index + 1} (${fragments[index].lang}) — not a full server`);
    }

    let fragmentCursor = 0;
    for (let index = 0; index < fullBlocks.length; index += 1) {
      const block = fullBlocks[index];
      const entries = viewEntries(block.code);

      if (entries.length > 0 && !viteAvailable) {
        stats.skippedWidgetsNoVite += 1;
        summary.skippedWidgetsNoVite += 1;
        log(
          `  SKIP  ${file} full-server #${index + 1} — needs vite to bundle ${entries.join(', ')} (vite not resolvable)`,
        );
        continue;
      }

      const srcDir = resetSrc(projectDir);
      for (const entry of entries) {
        const fragment = fragments[fragmentCursor];
        fragmentCursor += 1;
        if (!fragment) {
          fail(`${file}: full-server block references ${entry} but no view fragment is available`);
        }
        // View `entry:` paths are resolved relative to the server.ts directory (src/), not the root.
        const dest = resolve(srcDir, entry);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, fragment.code);
      }
      writeServer(projectDir, block.code);

      const validate = runCli(['validate', '--json'], projectDir);
      const envelope = parseEnvelope(validate.stdout);
      if (envelope?.ok !== true) {
        fail(
          `${file} full-server #${index + 1} failed noodle validate:\n` +
            `${validate.stdout}\n${validate.stderr}`,
        );
      }
      stats.validated += 1;
      summary.validated += 1;
      const suffix = entries.length > 0 ? ` (+view ${entries.join(', ')})` : '';
      log(`  OK    ${file} full-server #${index + 1} → noodle validate ok:true${suffix}`);
    }

    summary.byReference[file] = stats;
  }

  if (summary.validated === 0) fail('no full-server snippets found — reference format changed?');

  const skippedRefs = Object.entries(summary.byReference)
    .filter(([, s]) => s.skippedFragments > 0)
    .map(([file, s]) => `${file}(${s.skippedFragments})`);
  log(
    `  → validated ${summary.validated} full-server snippet(s); ` +
      `skipped ${summary.skippedFragments} non-full-server fragment(s) from ${skippedRefs.join(', ') || 'none'}` +
      (summary.skippedWidgetsNoVite > 0
        ? `; skipped ${summary.skippedWidgetsNoVite} widget snippet(s) (no vite)`
        : ''),
  );
  return summary;
}

// ---------------------------------------------------------------------------
// A10 — a fresh agent drives validate → repair → validate → test.
// ---------------------------------------------------------------------------
const BROKEN_SERVER = `import { server, tool, z } from '@noodleseed/one';

export default server('support', { title: 'Support', version: '1.0.0' }, [
  // Deliberate mistake: a tool name with a space/uppercase — invalid identifier.
  tool('Greet Person', {
    description: 'Greet a person by name.',
    input: z.object({ name: z.string().default('world') }),
    output: z.object({ message: z.string() }),
    fulfil: ({ input }) => ({ message: \`Hello, \${input.name}!\` }),
  }),
]);
`;

const FIXED_SERVER = BROKEN_SERVER.replace("'Greet Person'", "'greet'");

function runColdAgentLoop(projectDir) {
  log('── A10 cold-agent loop ──');

  // (i) The scaffolded context advertises the machine contract the agent drives.
  for (const relPath of [AGENTS_FILE, SKILL_FILE]) {
    const full = join(projectDir, relPath);
    if (!existsSync(full)) fail(`scaffold missing agent context file ${relPath}`);
    const content = readFileSync(full, 'utf8');
    for (const needle of REQUIRED_CONTEXT_STRINGS) {
      if (!content.includes(needle)) fail(`${relPath} does not advertise \`${needle}\``);
    }
    log(`  OK    ${relPath} advertises the --json contract`);
  }

  // (ii) Author a broken server; validate must cite an error code + path.
  resetSrc(projectDir);
  writeServer(projectDir, BROKEN_SERVER);
  const broken = runCli(['validate', '--json'], projectDir);
  const brokenEnvelope = parseEnvelope(broken.stdout);
  const firstError = brokenEnvelope?.error?.errors?.[0];
  if (
    brokenEnvelope?.ok !== false ||
    typeof brokenEnvelope.error?.code !== 'string' ||
    typeof firstError?.path !== 'string'
  ) {
    fail(
      `broken server did not fail with a coded/pathed error:\n${broken.stdout}\n${broken.stderr}`,
    );
  }
  log(
    `  OK    broken server → validate ok:false code=${brokenEnvelope.error.code} ` +
      `errors[0].code=${firstError.code} path=${firstError.path}`,
  );
  const brokenJson = JSON.stringify(brokenEnvelope);

  // (iii) Apply the obvious fix; validate goes green.
  writeServer(projectDir, FIXED_SERVER);
  const fixed = runCli(['validate', '--json'], projectDir);
  const fixedEnvelope = parseEnvelope(fixed.stdout);
  if (fixedEnvelope?.ok !== true) {
    fail(`fixed server did not validate:\n${fixed.stdout}\n${fixed.stderr}`);
  }
  log(`  OK    fixed server → validate ok:true`);
  const fixedJson = JSON.stringify(fixedEnvelope);

  // (iv) noodle test returns a valid envelope over the loopback MCP wire.
  const tested = runCli(['test', '--json'], projectDir);
  const testEnvelope = parseEnvelope(tested.stdout);
  if (!testEnvelope || typeof testEnvelope.ok !== 'boolean') {
    fail(`noodle test did not return a valid envelope:\n${tested.stdout}\n${tested.stderr}`);
  }
  if (testEnvelope.ok !== true || !Array.isArray(testEnvelope.data?.tools)) {
    fail(`noodle test envelope missing ok:true + data.tools:\n${tested.stdout}`);
  }
  log(`  OK    noodle test → ok:true tools=${JSON.stringify(testEnvelope.data.tools)}`);

  return { brokenJson, fixedJson, tools: testEnvelope.data.tools };
}

// ---------------------------------------------------------------------------
// Resource read-back gate — the double-wrap regression guard.
//
// `noodle validate` + `noodle test` both stay green for a resource whose `fulfil` returns the wrong
// `{ contents: [...] }` wrapper, because the mistake only surfaces when the resource is *read* over the
// wire. So validate-only gates missed it. This step reads a resource back through the real CLI+runtime
// (`noodle resources read --json`) and asserts (a) the shipped recipe teaches the bare shape, (b) a bare
// return renders clean `contents[0].text`, and (c) the wrapper shape now fails loudly instead of
// silently double-wrapping.
// ---------------------------------------------------------------------------
const CHANGELOG_TEXT = 'Changelog: 1.0.0 first release';

function readBackServer(fulfilBody) {
  return `import { resource, server, tool, z } from '@noodleseed/one';

export default server('readback', { title: 'Readback', version: '1.0.0' }, [
  tool('noop', {
    description: 'A trivial tool so the manifest has at least one tool.',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    fulfil: () => ({ ok: true }),
  }),
  resource('changelog', {
    uri: 'docs://changelog',
    title: 'Changelog',
    mimeType: 'text/markdown',
    fulfil: () => (${fulfilBody}),
  }),
]);
`;
}

function readResource(projectDir, uri) {
  const read = runCli(['resources', 'read', uri, '--json'], projectDir);
  return { envelope: parseEnvelope(read.stdout), raw: `${read.stdout}\n${read.stderr}` };
}

function runResourceReadBackGate(projectDir) {
  log('── resource read-back gate (double-wrap guard) ──');

  // (i) The shipped recipe the skill installs must teach the bare shape, not the `{ contents: [...] }`
  // wrapper. Read the on-disk reference the CLI wrote so we check the shipped bytes.
  const surfaceRef = join(projectDir, REFERENCES_SUBDIR, 'sdk-surface.md');
  if (!existsSync(surfaceRef)) fail(`scaffold missing sdk-surface reference at ${surfaceRef}`);
  const surface = readFileSync(surfaceRef, 'utf8');
  if (!/resource\('changelog'/.test(surface)) {
    fail('sdk-surface.md no longer contains the changelog resource recipe — format changed?');
  }
  // The recipe must teach the bare content-entry return, not the `{ contents: [...] }` wrapper. Assert the
  // bare fulfil is present, and that no fulfil returns a `contents: [` wrapper in code (the prose is allowed
  // to *mention* the wrapper to warn against it, so match the code shape `=> ({ ... contents: [` only).
  if (!/fulfil:[^\n]*=>\s*\(\{\s*uri: 'docs:\/\/changelog'/.test(surface)) {
    fail('sdk-surface.md changelog recipe no longer teaches the bare content-entry return shape');
  }
  if (/=>\s*\(\{\s*(?:\/\/[^\n]*\n\s*)?contents:\s*\[/.test(surface)) {
    fail(
      'sdk-surface.md resource recipe teaches the `{ contents: [...] }` double-wrap wrapper in code',
    );
  }
  log('  OK    sdk-surface.md resource recipe teaches the bare return shape (no contents wrapper)');

  // (ii) A bare return renders clean: contents[0].text is the real content, not a `{"contents":...}` blob.
  resetSrc(projectDir);
  writeServer(
    projectDir,
    readBackServer(
      `{ uri: 'docs://changelog', mimeType: 'text/markdown', text: '${CHANGELOG_TEXT}' }`,
    ),
  );
  // `readResource` boots the loopback runtime, which compiles server.ts itself — a compile failure
  // surfaces as `ok !== true` below, so a separate `validate` spawn here would only recompile for nothing.
  const clean = readResource(projectDir, 'docs://changelog');
  const cleanText = clean.envelope?.data?.result?.contents?.[0]?.text;
  if (clean.envelope?.ok !== true || cleanText !== CHANGELOG_TEXT) {
    fail(
      `bare-shape resource did not read back clean (got ${JSON.stringify(cleanText)}):\n${clean.raw}`,
    );
  }
  if (typeof cleanText === 'string' && cleanText.startsWith('{"contents"')) {
    fail(`bare-shape resource read back double-wrapped: ${cleanText}`);
  }
  log(`  OK    bare-shape resource → contents[0].text = ${JSON.stringify(cleanText)} (clean)`);

  // (iii) The wrapper shape must FAIL `noodle validate` loudly — the trap is closed at the layer agents
  // actually run (recordFulfilment rejects the wrapper during compile), not only at resource-read time.
  resetSrc(projectDir);
  writeServer(
    projectDir,
    readBackServer(
      `{ contents: [{ uri: 'docs://changelog', mimeType: 'text/markdown', text: '${CHANGELOG_TEXT}' }] }`,
    ),
  );
  const validWrap = parseEnvelope(runCli(['validate', '--json'], projectDir).stdout);
  if (validWrap?.ok !== false) {
    fail(
      'wrapper-shape resource must FAIL noodle validate — the double-wrap trap must be closed at the ' +
        'validate layer (the normal agent loop never reads the resource back)',
    );
  }
  log(
    '  OK    wrapper-shape resource → noodle validate fails loudly (trap closed at validate layer)',
  );

  return { readBack: 'ok' };
}

// ---------------------------------------------------------------------------
// Connector secret-scope gate — the "secret set at the wrong local scope" trap.
//
// Why this exists: two external agents burned time here. A connector needs `secret('X')`, they ran
// `noodle secrets set X --from-env X` (unscoped), and the local loopback endpoint answered an opaque
// `-32600 "not found"` because the value was never resolved at the scope the local runtime compiles
// against. Crucially `noodle validate` stays GREEN the whole time — secret-value binding is a
// deploy-time concern, explicitly NOT checked at author time (packages/cli/src/validate.ts:126-129) —
// so an agent that only runs `validate` never sees the problem; it only bites when the server BOOTS.
//
// Why the scope must match (cite before touching this):
//   • `noodle dev`/`test`/`tools`/`resources` all boot the SAME in-process loopback runtime via `dev()`
//     (packages/cli/src/commands/author-loop.ts); for an UNLINKED project (`readProjectLink()` is
//     undefined until a full `noodle link`) they resolve secrets under the hardcoded scope
//     org=local, app=<dir-slug>, env=dev (packages/cli/src/dev.ts:122-127).
//   • A connector's `secret('X')` must resolve at boot or the live compile fails CLOSED with
//     `missing_secret` — `no managed value found for required secret "X"`
//     (packages/service/src/registry.ts:405-412 + packages/service/src/registry-helpers.ts:35-53).
//   • With no served deployment the loopback endpoint answers HTTP 404 + JSON-RPC -32600 "not found"
//     (packages/transport-http/src/handler.ts:256, `rpcError(INVALID_REQUEST, 'not found')`); the clear
//     `missing_secret` line shows ONLY in the `noodle dev` boot log, never in the HTTP/JSON-RPC response.
//   • `noodle secrets set` derives its scope from the GLOBAL ~/.noodle/config.json target or explicit
//     --scope/--org/--app/--env flags — NOT the project link
//     (packages/cli/src/commands/config-values.ts:36-37,256-271). Local values live in ./.env.noodle
//     keyed by scope, and dev resolution walks the org→app→env scope chain
//     (packages/cli/src/local-config.ts:93-106,267-275).
//   • So the ROBUST fix that needs no app slug is ORG scope: `noodle secrets set X --scope org
//     --org local ...` — visible to every local app through the scope chain.
// ---------------------------------------------------------------------------

const CONNECTOR_SECRET_SERVER = `import { connector, secret, server, tool, z } from '@noodleseed/one';

// An HTTP connector whose bearer auth binds a managed secret. The secret MUST resolve at boot or the
// live compile fails CLOSED with \`missing_secret\` — the whole point of this scenario.
const demoApi = connector('demo_api')
  .version('1.0.0')
  .http({
    baseUrl: 'https://api.example.com',
    allowedOrigins: ['https://api.example.com'],
    auth: { kind: 'bearer', secret: secret('DEMO_TOKEN') },
    operations: {
      read_item: {
        type: 'read',
        method: 'GET',
        path: '/v1/item',
        output: z.object({ raw: z.unknown() }),
        response: { raw: '\${response}' },
      },
    },
  });

export default server('demo', { title: 'Demo', version: '1.0.0', use: { api: demoApi } }, [
  tool('read_item', {
    description: 'Read one item from the demo API via the connector.',
    input: z.object({}),
    output: z.object({ raw: z.unknown() }),
    fulfil: ({ connectors }) => {
      const item = connectors.api.read_item({});
      return { raw: item.raw };
    },
  }),
]);
`;

function toolsList(projectDir) {
  const res = runCli(['tools', 'list', '--json'], projectDir);
  return {
    envelope: parseEnvelope(res.stdout),
    status: res.status,
    raw: `${res.stdout}\n${res.stderr}`,
  };
}

function setLocalSecret(projectDir, scopeArgs) {
  // `--runtime local` is explicit on purpose: `noodle secrets set` otherwise defaults its runtime from the
  // GLOBAL ~/.noodle/config.json (`config.defaultRuntime`, config-values.ts:36), so a developer who is
  // logged into a cloud target would send this at the hosted control plane and fail with an auth error.
  // Forcing local keeps the gate offline + account-free regardless of the host's global config.
  //
  // A dummy value is enough: the secret only needs to RESOLVE (be present) for the connector to compile
  // at boot. `tools/list` never CALLS the tool, so the connector makes no network request — offline.
  return runCli(
    [
      'secrets',
      'set',
      'DEMO_TOKEN',
      '--runtime',
      'local',
      ...scopeArgs,
      '--value',
      'dummy-not-a-real-secret',
      '--json',
    ],
    projectDir,
  );
}

function runConnectorSecretScopeGate(projectDir) {
  log('── connector secret-scope gate (missing-secret trap) ──');

  // Fresh src with the connector server. No prior scenario sets secrets, so ./.env.noodle carries no
  // DEMO_TOKEN yet — the first check below runs against a genuinely unresolved secret.
  resetSrc(projectDir);
  writeServer(projectDir, CONNECTOR_SECRET_SERVER);

  // (i) validate stays GREEN with no secret — the trap is invisible to an agent that only validates.
  const validated = parseEnvelope(runCli(['validate', '--json'], projectDir).stdout);
  if (validated?.ok !== true) {
    fail(
      `connector server should validate green even with no secret set:\n${JSON.stringify(validated)}`,
    );
  }
  log(
    '  OK    noodle validate ok:true (secret binding is a deploy-time concern, not checked here)',
  );

  // (ii) NEGATIVE — no secret set: the live boot compiles CLOSED. `noodle tools` now names this as
  // `connector_secret_unresolved` with the scoped-secret fix (an external MCP client hitting the raw
  // loopback still sees the opaque JSON-RPC -32600 "not found" — the trap this gate protects against).
  const noSecret = toolsList(projectDir);
  const noSecretSecrets = noSecret.envelope?.error?.detail?.secrets;
  if (
    noSecret.envelope?.ok !== false ||
    noSecret.envelope.error?.code !== 'connector_secret_unresolved' ||
    !Array.isArray(noSecretSecrets) ||
    !noSecretSecrets.includes('DEMO_TOKEN')
  ) {
    fail(
      `no-secret tools/list must report connector_secret_unresolved naming DEMO_TOKEN:\n${noSecret.raw}`,
    );
  }
  log(
    `  OK    no secret → tools/list ok:false code=connector_secret_unresolved secrets=${JSON.stringify(noSecretSecrets)}`,
  );

  // (iii) NEGATIVE — secret set at the WRONG local scope. This is the precise trap: the set SUCCEEDS
  // (exit 0) but stores the value at org=local/app=not-the-dev-app/env=dev, a scope `noodle dev` (which
  // resolves org=local/app=<dir-slug>/env=dev) never walks — so the endpoint STILL returns "not found".
  const wrongSet = setLocalSecret(projectDir, [
    '--scope',
    'env',
    '--org',
    'local',
    '--app',
    'not-the-dev-app',
    '--env',
    'dev',
  ]);
  if (wrongSet.status !== 0) {
    fail(
      `wrong-scope \`secrets set\` should still succeed:\n${wrongSet.stdout}\n${wrongSet.stderr}`,
    );
  }
  const wrongScope = toolsList(projectDir);
  const wrongScopeSecrets = wrongScope.envelope?.error?.detail?.secrets;
  if (
    wrongScope.envelope?.ok !== false ||
    wrongScope.envelope.error?.code !== 'connector_secret_unresolved' ||
    !Array.isArray(wrongScopeSecrets) ||
    !wrongScopeSecrets.includes('DEMO_TOKEN')
  ) {
    fail(
      `secret at the wrong scope must STILL report connector_secret_unresolved (set succeeded; dev never resolves it):\n${wrongScope.raw}`,
    );
  }
  log(
    `  OK    secret set at the wrong scope → tools/list STILL ok:false code=connector_secret_unresolved (set succeeded; dev never resolves it)`,
  );

  // (iv) POSITIVE — secret set at the matching ORG scope resolves for every local app via the scope
  // chain (no app slug needed). The connector now compiles and the server serves tools/list. We assert
  // only that it BOOTS and the tool registers — no live tool call, no network.
  const rightSet = setLocalSecret(projectDir, ['--scope', 'org', '--org', 'local']);
  if (rightSet.status !== 0) {
    fail(
      `org-scope \`secrets set\` failed (exit ${rightSet.status}):\n${rightSet.stdout}\n${rightSet.stderr}`,
    );
  }
  const resolved = toolsList(projectDir);
  const tools = (resolved.envelope?.data?.tools ?? []).map((tool) => tool.name);
  if (resolved.envelope?.ok !== true || !tools.includes('read_item')) {
    fail(`org-scope secret did not let the server boot + serve read_item:\n${resolved.raw}`);
  }
  log(
    `  OK    secret at org scope → tools/list ok:true tools=${JSON.stringify(tools)} (secret resolved, server booted)`,
  );

  return { connectorSecretScope: 'ok' };
}

export function verifySkillSnippets() {
  if (!existsSync(CLI_BIN)) {
    fail(
      `CLI dist not built at ${CLI_BIN}. Run \`pnpm --filter "@noodleseed/one..." build\` first.`,
    );
  }

  const viteDir = resolveViteDir();
  const workRoot = mkdtempSync(join(tmpdir(), 'noodle-skill-snippets-'));
  try {
    const projectDir = scaffoldProject(workRoot);

    // Make vite resolvable from the throwaway project so widget views bundle offline (createRequire
    // walks up from the project's node_modules; a symlink to the workspace copy needs no install).
    let viteAvailable = false;
    if (viteDir) {
      const nodeModules = join(projectDir, 'node_modules');
      mkdirSync(nodeModules, { recursive: true });
      try {
        symlinkSync(viteDir, join(nodeModules, 'vite'), 'dir');
        viteAvailable = true;
      } catch {
        viteAvailable = false;
      }
    }
    if (!viteAvailable) {
      log('  note: vite not resolvable — widget-bundling snippets will be skipped');
    }

    const snippets = runSnippetGate(projectDir, viteAvailable);
    const coldAgent = runColdAgentLoop(projectDir);
    const resourceReadBack = runResourceReadBackGate(projectDir);
    const connectorSecretScope = runConnectorSecretScopeGate(projectDir);
    return {
      ...snippets,
      coldAgentLoop: 'ok',
      coldAgent,
      resourceReadBack: resourceReadBack.readBack,
      connectorSecretScope: connectorSecretScope.connectorSecretScope,
    };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function main() {
  const wantJson = process.argv.includes('--json');
  try {
    const result = verifySkillSnippets();
    log('');
    log(
      `PASS: ${result.validated} full-server snippet(s) validated, ` +
        `${result.skippedFragments} fragment(s) skipped, cold-agent loop ok.`,
    );
    if (wantJson) {
      log('');
      log('  broken validate JSON:');
      log(`    ${result.coldAgent.brokenJson}`);
      log('  fixed validate JSON:');
      log(`    ${result.coldAgent.fixedJson}`);
    }
    log(
      `SUMMARY: ${JSON.stringify({
        validated: result.validated,
        skippedFragments: result.skippedFragments,
        skippedWidgetsNoVite: result.skippedWidgetsNoVite,
        coldAgentLoop: result.coldAgentLoop,
        resourceReadBack: result.resourceReadBack,
        connectorSecretScope: result.connectorSecretScope,
        byReference: result.byReference,
      })}`,
    );
    process.exit(0);
  } catch (error) {
    log('');
    log(`FAIL: ${error.message}`);
    process.exit(1);
  }
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  main();
}
