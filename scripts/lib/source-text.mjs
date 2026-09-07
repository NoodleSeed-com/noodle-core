/**
 * Blank out template-literal contents so scaffold templates and fixture strings, which embed the
 * source of a *generated* project, are not read as this package's own imports or escape hatches.
 * Contents are replaced with spaces so every remaining match keeps its original line and offset.
 */
export function withoutTemplateLiterals(text) {
  let out = '';
  let inTemplate = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      out += inTemplate ? '  ' : text.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (ch === '`') {
      inTemplate = !inTemplate;
      out += '`';
      continue;
    }
    out += inTemplate && ch !== '\n' ? ' ' : ch;
  }
  return out;
}
