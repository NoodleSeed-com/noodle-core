/** Locale-aware display formatting helpers injected into generated widgets. */
export const WIDGET_FORMAT_SOURCE: string = `
  function attrFormat(el) {
    const kind = el.getAttribute('data-format-kind');
    if (!kind) return null;
    const out = { kind };
    for (const [attr, key] of [
      ['data-format-locale', 'locale'],
      ['data-format-currency', 'currency'],
      ['data-format-date-style', 'dateStyle'],
      ['data-format-time-style', 'timeStyle'],
      ['data-format-time-zone', 'timeZone'],
      ['data-format-unit', 'unit'],
      ['data-format-one', 'one'],
      ['data-format-other', 'other'],
    ]) {
      const value = el.getAttribute(attr);
      if (value) out[key] = value;
    }
    return out;
  }
  function applyFormat(value, format) {
    if (!format || value === undefined || value === null) return value;
    try {
      const locale = format.locale || 'en-US';
      if (format.kind === 'currency') return new Intl.NumberFormat(locale, { style: 'currency', currency: format.currency }).format(Number(value));
      if (format.kind === 'number') return new Intl.NumberFormat(locale).format(Number(value));
      if (format.kind === 'dateTime') {
        const date = new Date(String(value));
        if (Number.isNaN(date.getTime())) return value;
        return new Intl.DateTimeFormat(locale, {
          dateStyle: format.dateStyle || 'medium',
          ...(format.timeStyle ? { timeStyle: format.timeStyle } : {}),
          timeZone: format.timeZone || 'UTC',
        }).format(date);
      }
      if (format.kind === 'relativeTime') return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Number(value), format.unit);
      if (format.kind === 'unit') return new Intl.NumberFormat(locale, { style: 'unit', unit: format.unit }).format(Number(value));
      if (format.kind === 'plural') {
        const count = Number(value);
        const text = new Intl.PluralRules(locale).select(count) === 'one' ? format.one : format.other;
        if (String(text).includes('{{count}}')) return String(text).replaceAll('{{count}}', String(count));
        if (String(text).includes('{count}')) return String(text).replaceAll('{count}', String(count));
        return text === format.one ? text : String(count) + ' ' + text;
      }
    } catch (e) {}
    return value;
  }
`;
