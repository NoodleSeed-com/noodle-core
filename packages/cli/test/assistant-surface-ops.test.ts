import { describe, expect, it } from 'vitest';
import {
  type AssistantEmbedView,
  formatEmbedLines,
  parseBudgetFlags,
} from '../src/commands/assistant-surface-ops.js';

/**
 * Operating a public surface from the terminal.
 *
 * `budget set --turns-per-day 0` is the kill switch, so the two things that must never be ambiguous are
 * whether zero was actually applied, and whether a surface is currently off.
 */

const VIEW: AssistantEmbedView = {
  embedId: 'pub_7f2q4k9x0000000000000000',
  surfaceMode: 'public',
  origins: ['https://www.acme.test'],
  capabilities: ['ask_product', 'request_demo'],
  turnsPerDay: 1000,
  mintsPerDay: 300,
  bridgeCallsPerSession: 100,
  bridgeCallsPerDay: 20_000,
  budgetIsDefault: true,
  turnsToday: 12,
  mintsToday: 3,
  bridgeCallsToday: 41,
};

describe('parseBudgetFlags', () => {
  it('reads both caps', () => {
    expect(parseBudgetFlags(['set', '--turns-per-day', '50', '--mints-per-day', '20'])).toEqual({
      ok: true,
      body: { turnsPerDay: 50, mintsPerDay: 20 },
    });
  });

  it('carries zero through, because zero is the kill switch', () => {
    // The failure this guards against is a falsy check dropping the one value an operator most needs
    // to take effect.
    expect(parseBudgetFlags(['set', '--turns-per-day', '0'])).toEqual({
      ok: true,
      body: { turnsPerDay: 0 },
    });
  });

  it('leaves the cap it was not given alone', () => {
    expect(parseBudgetFlags(['set', '--mints-per-day', '5'])).toEqual({
      ok: true,
      body: { mintsPerDay: 5 },
    });
  });

  it('refuses values that could only be a mistake', () => {
    for (const bad of ['-1', '1.5', 'lots', undefined]) {
      const argv = bad === undefined ? ['set', '--turns-per-day'] : ['set', '--turns-per-day', bad];
      expect(parseBudgetFlags(argv).ok, `accepted ${String(bad)}`).toBe(false);
    }
  });

  it('refuses a no-op rather than reporting success', () => {
    // A mistyped flag name would otherwise print a budget that was never applied.
    expect(parseBudgetFlags(['set']).ok).toBe(false);
  });
});

/**
 * A cap the service enforces and the CLI cannot reach is a cap nobody can operate. Per-visitor
 * fairness is deliberately absent: it is not an operator's to tune, and lowering it would only
 * make their own site worse for people behind a shared address.
 */
it("reaches every cap the service enforces, and nothing that is not an operator's to set", () => {
  const parsed = parseBudgetFlags([
    '--turns-per-day',
    '30000',
    '--mints-per-day',
    '8000',
    '--mints-per-address-hour',
    '500',
    '--turns-per-address-hour',
    '2000',
  ]);

  expect(parsed).toEqual({
    ok: true,
    body: {
      turnsPerDay: 30_000,
      mintsPerDay: 8_000,
      mintsPerAddressHour: 500,
      turnsPerAddressHour: 2_000,
    },
  });
  expect(parseBudgetFlags(['--mints-per-visitor-hour', '5'])).toMatchObject({ ok: false });
});

describe('formatEmbedLines', () => {
  it('shows today’s spend beside the cap', () => {
    const text = formatEmbedLines(VIEW).join('\n');

    expect(text).toContain('pub_7f2q4k9x0000000000000000  public');
    expect(text).toContain('12 / 1000 (default)');
    expect(text).toContain('ask_product, request_demo');
  });

  it('shows browser-agent traffic, which spends neither a turn nor a mint', () => {
    // Without this line an operator reading only turns and mints sees a quiet day while a browser
    // agent works the surface, which is the exact confusion the bridge budgets exist to bound.
    expect(formatEmbedLines(VIEW).join('\n')).toContain('41 / 20000 (default)  (100 per session)');
  });

  /**
   * A sponsored surface degrades before it closes, and from the caps alone that is invisible — they
   * read normal right up to the moment the ladder shuts them. An operator who cannot see this cannot
   * tell platform-imposed degradation from a bug in their own app.
   */
  it('says what the platform is doing to a surface it is funding', () => {
    const text = formatEmbedLines({
      ...VIEW,
      managedSpend: {
        state: 'near',
        turnsRemaining: 1_240,
        visitors: 'Shorter answers, and conversations restart after 8 turns.',
      },
    }).join('\n');

    expect(text).toContain('Noodle-funded near');
    // Remaining turns, not a percentage: the spend consume is all-or-nothing, so a percentage would
    // look like it stopped early.
    expect(text).toContain('1,240 turns left today');
    expect(text).toContain('conversations restart after 8 turns');
    expect(text).not.toContain('%');
  });

  it('says nothing about platform spend on a surface the customer funds', () => {
    expect(formatEmbedLines(VIEW).join('\n')).not.toContain('Noodle-funded');
  });

  it('drops the default marker once an operator has chosen the cap', () => {
    expect(formatEmbedLines({ ...VIEW, budgetIsDefault: false }).join('\n')).not.toContain(
      '(default)',
    );
  });

  it('says plainly when a surface is switched off', () => {
    const text = formatEmbedLines({
      ...VIEW,
      turnsPerDay: 0,
      mintsPerDay: 0,
      budgetIsDefault: false,
    }).join('\n');

    // "0 / 0" alone reads like an idle surface. An operator checking whether the kill switch took
    // effect needs the answer as a word, not arithmetic.
    expect(text).toContain('OFF');
  });

  it('does not claim a surface is off while it still admits visitors', () => {
    // The two caps are independent doors: turnsPerDay 0 refuses every conversation but minting keeps
    // writing session rows, and mintsPerDay 0 turns away new visitors while open sessions continue.
    // Reporting either one as OFF tells an operator the surface is closed when half of it is open —
    // which is exactly the wrong answer during a kill-switch rehearsal.
    const turnsOnly = formatEmbedLines({
      ...VIEW,
      turnsPerDay: 0,
      mintsPerDay: 300,
      budgetIsDefault: false,
    }).join('\n');
    expect(turnsOnly).not.toContain('OFF');
    expect(turnsOnly).toContain('still minting');

    const mintsOnly = formatEmbedLines({
      ...VIEW,
      turnsPerDay: 1000,
      mintsPerDay: 0,
      budgetIsDefault: false,
    }).join('\n');
    expect(mintsOnly).not.toContain('OFF');
    expect(mintsOnly).toContain('open sessions continue');
  });

  it('says why a surface has no origins rather than showing a blank', () => {
    const text = formatEmbedLines({ ...VIEW, origins: [], capabilities: [] }).join('\n');
    expect(text).toContain('no active public surface');
  });
});

describe('bridge budget flags', () => {
  it('parses both bridge caps alongside the turn caps', () => {
    const parsed = parseBudgetFlags([
      '--turns-per-day',
      '500',
      '--bridge-calls-per-session',
      '25',
      '--bridge-calls-per-day',
      '900',
    ]);

    expect(parsed).toEqual({
      ok: true,
      body: { turnsPerDay: 500, bridgeToolCallsPerSession: 25, bridgeToolCallsPerDay: 900 },
    });
  });

  it('takes a bridge cap on its own, and takes zero', () => {
    expect(parseBudgetFlags(['--bridge-calls-per-day', '0'])).toEqual({
      ok: true,
      body: { bridgeToolCallsPerDay: 0 },
    });
  });

  it('rejects a bridge cap that is not a non-negative whole number', () => {
    expect(parseBudgetFlags(['--bridge-calls-per-session', '-1'])).toMatchObject({ ok: false });
    expect(parseBudgetFlags(['--bridge-calls-per-session'])).toMatchObject({ ok: false });
  });

  it('refuses a blank value rather than reading it as the kill switch', () => {
    // `Number('')` is 0, and 0 closes the bridge. A typo that empties the argument must not be a
    // silent shutdown of a surface's agent traffic.
    for (const flag of [
      '--bridge-calls-per-day',
      '--bridge-calls-per-session',
      '--turns-per-day',
    ]) {
      expect(parseBudgetFlags([flag, ''])).toEqual({
        ok: false,
        error: `${flag} requires a non-negative whole number`,
      });
      expect(parseBudgetFlags([flag, '   '])).toEqual({
        ok: false,
        error: `${flag} requires a non-negative whole number`,
      });
    }
    // An explicit zero is still the kill switch, and still allowed.
    expect(parseBudgetFlags(['--bridge-calls-per-day', '0'])).toEqual({
      ok: true,
      body: { bridgeToolCallsPerDay: 0 },
    });
  });

  it('names the bridge flags when nothing was set', () => {
    const parsed = parseBudgetFlags([]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('--bridge-calls-per-day');
  });
});
