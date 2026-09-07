/** Reject ASCII C0/DEL controls without regex literals that hide control ranges from linters. */
export function hasAsciiControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function hasWhitespaceOrAsciiControlCharacters(value: string): boolean {
  return [...value].some(
    (character) => /\s/u.test(character) || hasAsciiControlCharacters(character),
  );
}
