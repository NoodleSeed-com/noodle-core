import { describe, expect, it } from 'vitest';
import { sniffImageBytes } from '../src/mime-sniffing.js';

/**
 * The shared image sniffer is the authoritative MIME/dimension check for both compile-time local
 * asset validation (P0) and server-side hosted-upload re-sniffing (P1.5 B2). These tests pin the
 * supported formats and the rejection of non-image / active-content / truncated bytes so neither
 * caller can be fooled by an extension or a forged Content-Type.
 */

// 1x1 PNG (the fixture reused across the asset suites).
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

// GIF89a, 1x1 — header carries little-endian width/height at bytes 6/8.
const GIF_1X1 = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');

function pngWithDimensions(width: number, height: number): Buffer {
  const bytes = Buffer.from(PNG_1X1);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe('sniffImageBytes — supported formats', () => {
  it('detects PNG with header dimensions', () => {
    expect(sniffImageBytes(PNG_1X1)).toEqual({ mimeType: 'image/png', width: 1, height: 1 });
  });

  it('reads non-trivial PNG dimensions from the IHDR chunk', () => {
    expect(sniffImageBytes(pngWithDimensions(640, 480))).toEqual({
      mimeType: 'image/png',
      width: 640,
      height: 480,
    });
  });

  it('detects GIF with header dimensions', () => {
    expect(sniffImageBytes(GIF_1X1)).toEqual({ mimeType: 'image/gif', width: 1, height: 1 });
  });

  it('detects baseline JPEG dimensions from the SOF0 marker', () => {
    // Minimal JPEG: SOI, then an SOF0 (0xFFC0) segment declaring 3x7, then EOI.
    const jpeg = Buffer.from([
      0xff,
      0xd8, // SOI
      0xff,
      0xc0, // SOF0
      0x00,
      0x11, // segment length (17)
      0x08, // precision
      0x00,
      0x07, // height = 7
      0x00,
      0x03, // width = 3
      0x03, // components
      0x01,
      0x22,
      0x00,
      0x02,
      0x11,
      0x01,
      0x03,
      0x11,
      0x01,
      0xff,
      0xd9, // EOI
    ]);
    expect(sniffImageBytes(jpeg)).toEqual({ mimeType: 'image/jpeg', width: 3, height: 7 });
  });
});

describe('sniffImageBytes — rejections', () => {
  it('returns undefined for SVG (active content, never an accepted image)', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');
    expect(sniffImageBytes(svg)).toBeUndefined();
  });

  it('returns undefined for arbitrary non-image bytes', () => {
    expect(sniffImageBytes(Buffer.from('not an image at all', 'utf8'))).toBeUndefined();
  });

  it('returns undefined for a truncated PNG header', () => {
    expect(sniffImageBytes(PNG_1X1.subarray(0, 10))).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(sniffImageBytes(Buffer.alloc(0))).toBeUndefined();
  });
});
