import { WHATSAPP_META_GRAPH_VERSION, type WhatsAppMetaConfig } from './meta-cloud.js';

const NAMES = [
  'NOODLE_WHATSAPP_META_APP_ID',
  'NOODLE_WHATSAPP_META_APP_SECRET',
  'NOODLE_WHATSAPP_META_VERIFY_TOKEN',
] as const;
/**
 * Noodle Seed's Meta app for WhatsApp Cloud API bindings: all three variables or none, plus an optional
 * NOODLE_WHATSAPP_META_GRAPH_VERSION. Errors name variables only, never their values.
 */
export function resolveWhatsAppMetaConfig(
  env: Readonly<Record<string, string | undefined>>,
): WhatsAppMetaConfig | undefined {
  const [appId, appSecret, verifyToken] = NAMES.map((name) => env[name]);
  const graphVersion = env.NOODLE_WHATSAPP_META_GRAPH_VERSION;
  if (!appId && !appSecret && !verifyToken && graphVersion === undefined) return undefined;
  if (!appId || !appSecret || !verifyToken)
    throw new Error(`${NAMES.join(', ')} must be configured together`);
  if (!/^\d{1,32}$/.test(appId)) throw new Error('NOODLE_WHATSAPP_META_APP_ID must be numeric');
  const printable = /^[\x21-\x7e]{16,512}$/;
  if (!printable.test(appSecret) || !printable.test(verifyToken))
    throw new Error(
      'NOODLE_WHATSAPP_META_APP_SECRET and NOODLE_WHATSAPP_META_VERIFY_TOKEN must be 16-512 printable characters',
    );
  if (appSecret === verifyToken)
    throw new Error(
      'NOODLE_WHATSAPP_META_VERIFY_TOKEN must differ from NOODLE_WHATSAPP_META_APP_SECRET',
    );
  const version = graphVersion ?? WHATSAPP_META_GRAPH_VERSION;
  if (!/^v\d{1,3}\.\d{1,2}$/.test(version))
    throw new Error('NOODLE_WHATSAPP_META_GRAPH_VERSION must look like v25.0');
  return { appId, appSecret, verifyToken, graphVersion: version };
}
