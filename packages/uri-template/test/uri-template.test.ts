import { describe, expect, it } from 'vitest';
import { parseUriTemplate } from '../src/uri-template.js';

describe('parseUriTemplate', () => {
  it('classifies a fixed URI (no variables)', () => {
    const result = parseUriTemplate('docs://changelog');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('fixed');
  });

  it('classifies and matches a single-variable template', () => {
    const result = parseUriTemplate('tickets://{id}');
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === 'template') {
      expect(result.value.variables).toEqual(['id']);
      expect(result.value.match('tickets://42')).toEqual({ id: '42' });
      expect(result.value.match('tickets://42/extra')).toBeNull(); // a var is one segment
      expect(result.value.match('other://42')).toBeNull();
    }
  });

  it('matches a multi-variable template', () => {
    const result = parseUriTemplate('users://{userId}/posts/{postId}');
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === 'template') {
      expect(result.value.variables).toEqual(['userId', 'postId']);
      expect(result.value.match('users://7/posts/99')).toEqual({ userId: '7', postId: '99' });
      expect(result.value.match('users://7/posts')).toBeNull();
    }
  });

  it('percent-decodes extracted variables', () => {
    const result = parseUriTemplate('q://{term}');
    if (result.ok && result.value.kind === 'template') {
      expect(result.value.match('q://a%20b')).toEqual({ term: 'a b' });
    }
  });

  it('treats malformed percent-encoded variables as no match rather than throwing', () => {
    const result = parseUriTemplate('q://{term}');
    if (result.ok && result.value.kind === 'template') {
      expect(result.value.match('q://bad%ZZ')).toBeNull();
    }
  });

  it('matches regex metacharacters in literal URI segments literally', () => {
    const result = parseUriTemplate('docs+v1.2://items/{id}?kind=(a)');
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === 'template') {
      expect(result.value.match('docs+v1.2://items/7?kind=(a)')).toEqual({ id: '7' });
      expect(result.value.match('docs-v1x2://items/7?kind=(a)')).toBeNull();
    }
  });

  it('rejects RFC 6570 operator forms (only simple {var} is supported)', () => {
    for (const uri of ['x://{+path}', 'x://{?q}', 'x://{#frag}', 'x://{var*}', 'x://{var:3}']) {
      const result = parseUriTemplate(uri);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects duplicate variables and empty expressions', () => {
    expect(parseUriTemplate('x://{id}/{id}').ok).toBe(false);
    expect(parseUriTemplate('x://{}').ok).toBe(false);
  });

  it('rejects templates with more than the supported variable bound', () => {
    const vars = Array.from({ length: 17 }, (_, i) => `{v${i}}`).join('/');
    expect(parseUriTemplate(`x://${vars}`).ok).toBe(false);
  });

  it('rejects an over-long template (bounds)', () => {
    expect(parseUriTemplate(`x://${'a'.repeat(3000)}`).ok).toBe(false);
  });
});
