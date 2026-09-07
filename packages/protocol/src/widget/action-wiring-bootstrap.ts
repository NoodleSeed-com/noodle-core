/** CSP-safe declarative action listener wiring spliced into the shared widget bootstrap. */
export const WIDGET_ACTION_WIRING_SOURCE: string = `
  function wireActions(root) {
    root = root || document;
    for (const el of root.querySelectorAll('[data-action]')) {
      if (el.hasAttribute('data-noodle-wired')) continue;
      el.setAttribute('data-noodle-wired', '');
      el.addEventListener('click', () => actOnce(el));
    }
  }
`;
