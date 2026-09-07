import { describe, expect, it } from 'vitest';
import { assertQualificationManifest } from '../../../scripts/verify-project-scaffolds.mjs';

describe('packed starter qualification', () => {
  it('verifies exact pins without rewriting the generated customer manifest', () => {
    const original = {
      name: 'customer',
      scripts: { test: 'vitest run --dir test' },
      devDependencies: { '@noodleseed/one': '1.2.3', vitest: '4.1.8' },
      dependencies: { react: '19.2.7' },
    };
    const before = JSON.stringify(original);
    expect(() => assertQualificationManifest(original, '1.2.3')).not.toThrow();
    expect(JSON.stringify(original)).toBe(before);
  });

  it('rejects a different CLI candidate instead of silently substituting it', () => {
    expect(() =>
      assertQualificationManifest({ devDependencies: { '@noodleseed/one': '1.2.4' } }, '1.2.3'),
    ).toThrow(/candidate/);
  });

  it.each(['dependencies', 'devDependencies'])('rejects moving pins in %s', (field) => {
    expect(() =>
      assertQualificationManifest(
        {
          devDependencies: { '@noodleseed/one': '1.2.3' },
          [field]: { surprise: 'latest', '@noodleseed/one': '1.2.3' },
        },
        '1.2.3',
      ),
    ).toThrow(/exact dependency pins/);
  });
});
