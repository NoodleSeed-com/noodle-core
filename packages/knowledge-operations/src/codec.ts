/**
 * Bridges the service's async string secret box to the revision store's byte codec, so sealed
 * knowledge text shares the platform's KMS/static master-key custody instead of a second
 * encryption scheme. Structurally typed: no dependency on the service or runtime packages.
 */
import type { DocumentTextCodec } from '@noodle-borg/knowledge/portable';

export interface StringSecretBox {
  seal(plaintext: string): Promise<unknown>;
  open(sealed: never): Promise<string>;
}

export function secretBoxDocumentCodec(box: StringSecretBox): DocumentTextCodec {
  return {
    seal: async (plaintext) =>
      Buffer.from(JSON.stringify(await box.seal(plaintext.toString('base64'))), 'utf8'),
    open: async (sealed) =>
      Buffer.from(await box.open(JSON.parse(sealed.toString('utf8')) as never), 'base64'),
  };
}
