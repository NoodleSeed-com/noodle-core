import type { ChannelCipher } from '@noodle-borg/assistant-gateway/portable';
import type { SealedSecret, SecretBox } from '@noodle-borg/runtime';
import { z } from 'zod';

const envelope = z
  .object({
    v: z.number(),
    algo: z.string(),
    keyId: z.string(),
    iv: z.string(),
    tag: z.string(),
    ct: z.string(),
  })
  .passthrough();
export class ChannelSecretBoxCipher implements ChannelCipher {
  constructor(private readonly box: SecretBox) {}
  seal(scope: string, id: string, value: unknown): Promise<unknown> {
    return this.box.seal(JSON.stringify({ purpose: 'assistant-channel-v1', scope, id, value }));
  }
  async open(scope: string, id: string, sealed: unknown): Promise<unknown> {
    const parsed = envelope.parse(sealed) as SealedSecret;
    const value: unknown = JSON.parse(await this.box.open(parsed));
    const opened = z
      .object({
        purpose: z.literal('assistant-channel-v1'),
        scope: z.string(),
        id: z.string(),
        value: z.unknown(),
      })
      .strict()
      .parse(value);
    if (opened.scope !== scope || opened.id !== id)
      throw new Error('channel payload context mismatch');
    return opened.value;
  }
}
