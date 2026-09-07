import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAssistantEmbed } from '../src/commands/assistant-embed-ops.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function generate(dir: string, flags: readonly string[] = []) {
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));
  const code = await runAssistantEmbed(
    ['--framework', 'django-vue', '--dir', dir, '--no-agents', '--json', ...flags],
    {},
    {},
  );
  return { code, report: JSON.parse(output.join('\n')) };
}

describe('Django/Vue integration profile', () => {
  it('supplies one fail-closed identity seam, preserved CSRF, static Vue mounting and runnable tests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodle-django-profile-'));
    roots.push(dir);
    const { code, report } = await generate(dir);
    expect(code).toBe(0);
    expect(report.data.recipe.id).toBe('django-vue-authenticated');
    expect(report.data.integrationVerified).toBe(false);
    expect(report.data.recipe.applicationSeams).toContain('authenticate_assistant_request');
    const view = readFileSync(join(dir, 'noodle_assistant/views.py'), 'utf8');
    expect(view).not.toContain('csrf_exempt');
    expect(view).toContain('csrf_protect');
    expect(view).toContain('allow_redirects=False');
    expect(readFileSync(join(dir, 'noodle_assistant/auth.py'), 'utf8')).toContain('return None');
    const component = readFileSync(join(dir, 'src/components/NoodleAssistant.vue'), 'utf8');
    expect(component).toContain('element.fetch =');
    expect(component.indexOf('element.fetch =')).toBeLessThan(component.indexOf('append(element)'));
    expect(component).not.toContain('NOODLE_ASSISTANT_CLIENT_SECRET');
    expect(readFileSync(join(dir, 'noodle_assistant/tests.py'), 'utf8')).toContain(
      'enforce_csrf_checks=True',
    );
    expect(readFileSync(join(dir, 'test/noodle-assistant-transport.test.ts'), 'utf8')).toContain(
      'X-CSRFToken',
    );
    expect(report.data.nextSteps.join('\n')).not.toContain('lib/noodle-assistant-auth.ts');
  });

  it('preserves customized Python files and rejects unsupported surfaces before writing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodle-django-reconcile-'));
    roots.push(dir);
    expect((await generate(dir)).code).toBe(0);
    const authPath = join(dir, 'noodle_assistant/auth.py');
    writeFileSync(authPath, '# Customer session implementation\n');
    const rerun = await generate(dir);
    expect(rerun.code).toBe(0);
    expect(rerun.report.data.files).toContainEqual(
      expect.objectContaining({ path: 'noodle_assistant/auth.py', action: 'skipped' }),
    );
    expect(readFileSync(authPath, 'utf8')).toBe('# Customer session implementation\n');
    const denied = await generate(dir, ['--surface', 'public']);
    expect(denied.code).toBe(2);
    expect(denied.report.error.code).toBe('assistant_host_surface_unsupported');
  });
});
