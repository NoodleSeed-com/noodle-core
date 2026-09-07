import { describe, expect, it } from 'vitest';
import { parseRobots } from '../src/robots.js';

describe('robots.txt parsing', () => {
  it('honors the * group with longest-match precedence between Allow and Disallow', () => {
    const robots = parseRobots(`
User-agent: *
Disallow: /admin/
Allow: /admin/public/
Disallow: /tmp

User-agent: OtherBot
Disallow: /
`);
    expect(robots.isAllowed('/docs/a')).toBe(true);
    expect(robots.isAllowed('/admin/secret')).toBe(false);
    expect(robots.isAllowed('/admin/public/page')).toBe(true);
    expect(robots.isAllowed('/tmpfile')).toBe(false);
  });

  it('collects sitemap URLs and allows everything for an empty or missing file', () => {
    const robots = parseRobots(`Sitemap: https://acme.test/sitemap.xml
User-agent: *
Allow: /
Sitemap: https://acme.test/sitemap-blog.xml`);
    expect(robots.sitemaps).toEqual([
      'https://acme.test/sitemap.xml',
      'https://acme.test/sitemap-blog.xml',
    ]);
    expect(parseRobots('').isAllowed('/anything')).toBe(true);
  });

  it('treats a bare "Disallow:" (empty value) as allow-all per the de-facto standard', () => {
    const robots = parseRobots('User-agent: *\nDisallow:');
    expect(robots.isAllowed('/x')).toBe(true);
  });
});
