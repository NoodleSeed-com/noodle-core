/**
 * Permissive image byte-sniffing shared by the compiler (P0 local-asset validation) and the service
 * (P1.5 B2 server-side re-sniff before activating a hosted upload). The detector reads only header
 * bytes — it never decodes pixel data — so it is safe to run on untrusted bytes and cheap enough to
 * call on a bounded sample. SVG and any non-image bytes return `undefined` (rejected by callers).
 *
 * Moved verbatim from `assets.ts` so both the compile path and the hosted-upload verification path
 * apply identical MIME/dimension rules; there is no second sniffing style.
 */

export interface SniffedImage {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

export function sniffImageBytes(bytes: Buffer): SniffedImage | undefined {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes.toString('ascii', 1, 4) === 'PNG' &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'GIF') {
    return { mimeType: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (
    bytes.length >= 30 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return sniffWebp(bytes);
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return sniffJpeg(bytes);
  }
  return undefined;
}

function sniffJpeg(bytes: Buffer): SniffedImage | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3) {
      return {
        mimeType: 'image/jpeg',
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function sniffWebp(bytes: Buffer): SniffedImage | undefined {
  const kind = bytes.toString('ascii', 12, 16);
  if (kind === 'VP8 ' && bytes.length >= 30) {
    return {
      mimeType: 'image/webp',
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (kind === 'VP8L' && bytes.length >= 25) {
    const b0 = bytes[21] as number;
    const b1 = bytes[22] as number;
    const b2 = bytes[23] as number;
    const b3 = bytes[24] as number;
    return {
      mimeType: 'image/webp',
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + ((b3 << 6) | (b2 >> 2) | ((b1 & 0xc0) << 2)),
    };
  }
  if (kind === 'VP8X' && bytes.length >= 30) {
    return {
      mimeType: 'image/webp',
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  return undefined;
}
