import { describe, expect, it } from 'vitest';
import { extractHtmlText, extractHtmlTitle } from '../src/html-text.js';

describe('html text extraction', () => {
  it('extracts the title and visible text, dropping script/style/markup', () => {
    const html = `<!doctype html><html><head><title>Pricing — Acme</title>
      <style>body { color: red }</style>
      <script>alert('never index me')</script></head>
      <body><h1>Pricing</h1><p>Plans start at <b>$10</b> per seat.</p>
      <noscript>enable js</noscript></body></html>`;
    expect(extractHtmlTitle(html)).toBe('Pricing — Acme');
    const text = extractHtmlText(html);
    expect(text).toContain('Plans start at $10 per seat.');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('enable js');
    expect(text).not.toContain('<');
  });

  it('decodes common entities and collapses whitespace', () => {
    const html =
      '<p>Fish &amp; Chips&nbsp;&mdash; &quot;fresh&quot;   daily &#8212; &lt;really&gt;</p>';
    expect(extractHtmlText(html)).toBe('Fish & Chips — "fresh" daily — <really>');
  });

  it('falls back to the first heading when there is no title, and to empty otherwise', () => {
    expect(extractHtmlTitle('<h1>  Docs Home </h1><p>x</p>')).toBe('Docs Home');
    expect(extractHtmlTitle('<p>no headings here</p>')).toBe('');
  });

  it('inserts word breaks at block boundaries so words never fuse', () => {
    const text = extractHtmlText('<div>alpha</div><div>beta</div><li>gamma</li>');
    expect(text).toBe('alpha beta gamma');
  });
});
