import { type AuthReadiness, authReadinessForEntrypoint } from './auth-ops.js';

export async function customerDeployAuthReadiness(
  entrypoint: string,
  enabled: boolean,
): Promise<AuthReadiness | undefined> {
  if (!enabled) return undefined;
  try {
    return await authReadinessForEntrypoint(entrypoint);
  } catch {
    return {
      ready: false,
      checks: [
        {
          code: 'auth_readiness_internal',
          level: 'FAIL',
          name: 'OAuth readiness',
          message: 'readiness diagnostics could not complete',
          fix: 'Run noodle auth doctor src/server.ts for a complete diagnosis.',
        },
      ],
    };
  }
}

export function printAuthReadinessWarnings(readiness: AuthReadiness): void {
  console.log(
    'OAuth readiness warning: Deploy succeeded, but some remote MCP clients may not connect.',
  );
  const findings = readiness.checks.filter((check) => check.level === 'FAIL');
  const groups = new Map<string, typeof findings>();
  for (const check of findings) {
    const label = check.issuer ?? 'General';
    groups.set(label, [...(groups.get(label) ?? []), check]);
  }
  for (const [issuer, checks] of groups) {
    console.log(`  ${issuer}`);
    for (const check of checks) {
      console.log(`    [${check.code}] ${check.name}: ${check.message}`);
      if (check.fix !== undefined) console.log(`      Fix: ${check.fix}`);
    }
  }
  console.log('  Next: noodle auth doctor src/server.ts');
}
