import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

describe('bitcoin example', () => {
  it('exports a Noodle server definition', () => {
    expect(typeof app.toManifest).toBe('function');
  });
});
