import { describe, expect, it } from 'vitest';
import {
  DESIGN_STYLE_PROPERTIES,
  sanitizeElementEvidence,
  sanitizeVisibleText,
  validateDesignSession,
} from '../src/devtools-design-contract.js';

const change = {
  property: 'background-color',
  from: 'rgb(0, 0, 0)',
  to: '#ff6b35',
} as const;

function target() {
  return {
    tagName: 'button',
    role: 'button',
    accessibleName: 'Search stores',
    visibleText: 'Search stores',
    stableId: 'search-stores',
    classNames: ['action', 'primary'],
    authorHints: { testId: 'search-stores' },
    ancestry: [
      {
        tagName: 'form',
        role: 'form',
        stableId: 'store-search',
        classNames: ['search'],
        nthOfType: 1,
      },
    ],
    siblingIndex: 0,
    siblingCount: 2,
    rect: { x: 12, y: 24, width: 180, height: 44 },
    computedStyles: {
      color: 'rgb(255, 255, 255)',
      'background-color': 'rgb(0, 0, 0)',
    },
    resolution: {
      confidence: 100,
      evidence: ['stable id', 'role and accessible name'],
      status: 'resolved',
    },
  } as const;
}

function session() {
  return {
    version: 1,
    id: 'draft-session',
    status: 'draft',
    project: {
      entrypoint: 'src/server.ts',
      toolName: 'open_ordering',
      resourceUri: 'ui://food-ordering/open-ordering',
    },
    viewport: {
      width: 390,
      height: 844,
      device: 'mobile',
      theme: 'dark',
    },
    createdAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:01:00.000Z',
    annotations: [
      {
        id: 'annotation-1',
        intent: 'Make this action feel primary.',
        target: target(),
        changes: [change],
        acceptanceCriteria: ['The action remains readable at 390px.'],
        preserve: ['Keep the button label and click behavior.'],
      },
    ],
  } as const;
}

describe('devtools Design Session contract', () => {
  it('accepts the complete closed v1 contract without changing its values', () => {
    expect(validateDesignSession(session())).toEqual(session());
  });

  it('rejects unsupported versions and unknown fields instead of silently dropping them', () => {
    expect(() => validateDesignSession({ ...session(), version: 2 })).toThrow(
      'unsupported Design Session version',
    );
    expect(() => validateDesignSession({ ...session(), extra: true })).toThrow(
      'unknown Design Session field: extra',
    );
    expect(() =>
      validateDesignSession({
        ...session(),
        project: { ...session().project, projectRoot: '/private/project' },
      }),
    ).toThrow('unknown Design Session project field: projectRoot');
    expect(() =>
      validateDesignSession({
        ...session(),
        annotations: [
          {
            ...session().annotations[0],
            target: {
              ...target(),
              ancestry: [{ ...target().ancestry[0], unexpected: true }],
            },
          },
        ],
      }),
    ).toThrow('unknown annotations[0].target.ancestry[0] field: unexpected');
  });

  it('accepts only a project-relative authored entrypoint', () => {
    for (const entrypoint of [
      '/private/work/project/src/server.ts',
      'C:\\work\\project\\src\\server.ts',
      '../outside/server.ts',
    ]) {
      expect(() =>
        validateDesignSession({
          ...session(),
          project: { ...session().project, entrypoint },
        }),
      ).toThrow('project.entrypoint must be project-relative');
    }
  });

  it('rejects malformed timestamps, rectangles, style properties, and oversized collections', () => {
    expect(() => validateDesignSession({ ...session(), updatedAt: 'tomorrow' })).toThrow(
      'updatedAt must be an ISO timestamp',
    );
    expect(() =>
      validateDesignSession({
        ...session(),
        annotations: [
          {
            ...session().annotations[0],
            target: { ...target(), rect: { ...target().rect, width: Number.POSITIVE_INFINITY } },
          },
        ],
      }),
    ).toThrow('annotations[0].target.rect.width must be a finite number');
    expect(() =>
      validateDesignSession({
        ...session(),
        annotations: [
          {
            ...session().annotations[0],
            changes: [{ property: 'position', from: 'static', to: 'fixed' }],
          },
        ],
      }),
    ).toThrow('annotations[0].changes[0].property is unsupported');
    expect(() =>
      validateDesignSession({
        ...session(),
        annotations: Array.from({ length: 101 }, () => session().annotations[0]),
      }),
    ).toThrow('annotations must contain at most 100 items');
    expect(() =>
      validateDesignSession({
        ...session(),
        annotations: [
          {
            ...session().annotations[0],
            changes: Array.from({ length: 101 }, () => change),
          },
        ],
      }),
    ).toThrow('annotations[0].changes must contain at most 100 items');
  });

  it('exports only the bounded visual properties approved for the first release', () => {
    expect(DESIGN_STYLE_PROPERTIES).toEqual([
      'color',
      'font-family',
      'font-size',
      'font-weight',
      'line-height',
      'letter-spacing',
      'text-align',
      'background-color',
      'opacity',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'margin-top',
      'margin-right',
      'margin-bottom',
      'margin-left',
      'row-gap',
      'column-gap',
      'display',
      'flex-direction',
      'align-items',
      'justify-content',
      'width',
      'min-width',
      'max-width',
      'height',
      'min-height',
      'max-height',
      'border-color',
      'border-width',
      'border-style',
      'border-radius',
    ]);
  });
});

describe('devtools element evidence sanitization', () => {
  it('normalizes visible text and caps it at 160 characters', () => {
    const sanitized = sanitizeVisibleText(`  Save\n\n changes ${'x'.repeat(300)}`);
    expect(sanitized.startsWith('Save changes ')).toBe(true);
    expect(sanitized).toHaveLength(160);
  });

  it('sorts sanitized class evidence before applying the persisted cap', () => {
    expect(
      sanitizeElementEvidence({
        ...target(),
        classNames: ['zeta', 'alpha', 'middle'],
      }).classNames,
    ).toEqual(['alpha', 'middle', 'zeta']);
  });

  it('keeps safe author evidence while excluding form values, hidden text, URLs, and secrets', () => {
    const sanitized = sanitizeElementEvidence({
      tagName: 'INPUT',
      role: 'textbox',
      accessibleName: 'Card number',
      visibleText: '  Pay   securely  ',
      id: 'checkout-card',
      classNames: Array.from({ length: 30 }, (_, index) => `class-${index}`),
      attributes: {
        'data-testid': 'checkout-card',
        'data-test': 'payment',
        'data-component': 'CardField',
        'data-session-token': 'session-token',
        href: 'https://example.com/pay?secret-query=1',
        value: '0000 0000 0000 0000',
      },
      hiddenText: 'internal discount',
      ancestry: Array.from({ length: 8 }, (_, index) => ({
        tagName: 'DIV',
        id: `ancestor-${index}`,
        classNames: [`level-${index}`],
        nthOfType: index + 1,
      })),
      siblingIndex: 1,
      siblingCount: 3,
      rect: { x: 1, y: 2, width: 300, height: 48 },
      computedStyles: {
        color: 'rgb(255, 255, 255)',
        position: 'fixed',
      },
      resolution: {
        confidence: 92,
        evidence: ['author hint'],
        status: 'resolved',
      },
    });

    expect(sanitized).toEqual({
      tagName: 'input',
      role: 'textbox',
      accessibleName: 'Card number',
      visibleText: 'Pay securely',
      stableId: 'checkout-card',
      classNames: [
        'class-0',
        'class-1',
        'class-10',
        'class-11',
        'class-12',
        'class-13',
        'class-14',
        'class-15',
        'class-16',
        'class-17',
        'class-18',
        'class-19',
        'class-2',
        'class-20',
        'class-21',
        'class-22',
        'class-23',
        'class-24',
        'class-25',
        'class-26',
      ],
      authorHints: {
        testId: 'checkout-card',
        test: 'payment',
        component: 'CardField',
      },
      ancestry: Array.from({ length: 6 }, (_, index) => ({
        tagName: 'div',
        stableId: `ancestor-${index}`,
        classNames: [`level-${index}`],
        nthOfType: index + 1,
      })),
      siblingIndex: 1,
      siblingCount: 3,
      rect: { x: 1, y: 2, width: 300, height: 48 },
      computedStyles: { color: 'rgb(255, 255, 255)' },
      resolution: {
        confidence: 92,
        evidence: ['author hint'],
        status: 'resolved',
      },
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /0000|session-token|secret-query|internal discount|position/,
    );
  });

  it('drops generated-looking ids and rejects invalid numeric evidence', () => {
    expect(
      sanitizeElementEvidence({
        ...target(),
        stableId: undefined,
        id: ':r17:',
      }).stableId,
    ).toBeUndefined();
    expect(() =>
      sanitizeElementEvidence({
        ...target(),
        rect: { ...target().rect, height: Number.NaN },
      }),
    ).toThrow('element.rect.height must be a finite number');
  });
});
