import { isIP } from 'node:net';

/** A production HTTPS URL with a DNS hostname and no reserved test/local suffix. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    isIP(hostname) !== 0 ||
    !hostname.includes('.')
  )
    return false;
  return !['.example', '.invalid', '.internal', '.local', '.localhost', '.test', '.home.arpa'].some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
  );
}
