import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import * as reactSurface from '../src/react.js';

describe('React package boundary', () => {
  it('keeps browser UI out of the server-safe authoring root', () => {
    expect('generateHelpers' in core).toBe(false);
    expect('Dialog' in core).toBe(false);
    expect('Input' in core).toBe(false);
  });

  it('exposes the complete optional kit from the React subpath', () => {
    for (const name of ['generateHelpers', 'Input', 'Field', 'Menu', 'Overlay', 'Frame']) {
      expect(reactSurface).toHaveProperty(name);
    }
  });
});
