import { createHash } from 'node:crypto';
import type { QuickJSContext } from 'quickjs-emscripten';

/** Worker-local pure capabilities: bounded arguments and calls, never an ambient host clock. */
export function installDeterministicHelpers(context: QuickJSContext): void {
  let calls = 0;
  const formatters = new Map<string, Intl.DateTimeFormat>();
  const fn = context.newFunction('__explicitHelper', (operationHandle, argsHandle) => {
    try {
      calls += 1;
      if (calls > 4096) throw new Error('explicit helper call budget exceeded');
      const operation = context.getString(operationHandle);
      const json = context.getString(argsHandle);
      if (json.length > 16_384) throw new Error('explicit helper input exceeds its bound');
      const args: unknown = JSON.parse(json);
      if (!Array.isArray(args)) throw new Error('explicit helper arguments are invalid');
      let result: unknown;
      if (operation === 'parse') {
        const value = args[0];
        if (
          typeof value !== 'string' ||
          value.length > 64 ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
        )
          throw new Error('explicit instant is invalid');
        const year = Number(value.slice(0, 4));
        const month = Number(value.slice(5, 7));
        const day = Number(value.slice(8, 10));
        const maxDay = new Date(`${value.slice(0, 7)}-01T00:00:00Z`);
        maxDay.setUTCMonth(month);
        maxDay.setUTCDate(0);
        const millis = Date.parse(value);
        if (
          !Number.isFinite(millis) ||
          month < 1 ||
          month > 12 ||
          day < 1 ||
          day > maxDay.getUTCDate() ||
          year < 1 ||
          Number(value.slice(11, 13)) > 23 ||
          Number(value.slice(14, 16)) > 59 ||
          Number(value.slice(17, 19)) > 59
        )
          throw new Error('explicit instant is invalid');
        result = millis;
      } else if (operation === 'format' || operation === 'parts') {
        const epoch = args[0];
        if (
          typeof epoch !== 'number' ||
          !Number.isInteger(epoch) ||
          epoch < -62135596800000 ||
          epoch > 253402300799999
        )
          throw new Error('explicit instant is invalid');
        if (operation === 'format') result = new Date(epoch).toISOString();
        else {
          const zone = args[1];
          if (
            typeof zone !== 'string' ||
            zone.length < 1 ||
            zone.length > 64 ||
            zone.trim() !== zone
          )
            throw new Error('explicit time zone is invalid');
          let formatter = formatters.get(zone);
          if (!formatter) {
            if (formatters.size >= 16)
              throw new Error('explicit time zone count exceeds its bound');
            formatter = new Intl.DateTimeFormat('en-US', {
              timeZone: zone,
              weekday: 'short',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
            });
            formatters.set(zone, formatter);
          }
          const parts = Object.fromEntries(
            formatter.formatToParts(epoch).map(({ type, value }) => [type, value]),
          );
          const weekday =
            ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday ?? '') + 1;
          result = {
            date: `${parts.year}-${parts.month}-${parts.day}`,
            weekday,
            hour: Number(parts.hour),
            minute: Number(parts.minute),
          };
        }
      } else if (operation === 'digest') {
        const value = args[0];
        const encoding = args[1] ?? 'hex';
        if (
          typeof value !== 'string' ||
          value.length > 8192 ||
          (encoding !== 'hex' && encoding !== 'base32hex')
        )
          throw new Error('explicit digest input is invalid');
        const digest = createHash('sha256').update(value, 'utf8').digest();
        if (encoding === 'hex') result = digest.toString('hex');
        else {
          let bits = 0;
          let value = 0;
          let output = '';
          const alphabet = '0123456789abcdefghijklmnopqrstuv';
          for (const byte of digest) {
            value = (value << 8) | byte;
            bits += 8;
            while (bits >= 5) {
              output += alphabet[(value >>> (bits - 5)) & 31];
              bits -= 5;
            }
          }
          if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
          result = output;
        }
      } else throw new Error('explicit helper is not available');
      return context.newString(JSON.stringify({ ok: true, value: result }));
    } catch {
      return context.newString(
        JSON.stringify({ ok: false, error: 'invalid or exhausted explicit helper request' }),
      );
    }
  });
  context.setProp(context.global, '__explicitHelper', fn);
  fn.dispose();
}

export const helperPrelude = `
var __helper = function(operation, args) {
  var result = JSON.parse(globalThis.__explicitHelper(operation, JSON.stringify(args)));
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
var __timeHelpers = Object.freeze({
  parse: function(value) { return __helper('parse', [value]); },
  format: function(value) { return __helper('format', [value]); },
  parts: function(value, timeZone) { return __helper('parts', [value, timeZone]); }
});
var __digestHelper = function(value, encoding) { return __helper('digest', [value, encoding]); };
`;
