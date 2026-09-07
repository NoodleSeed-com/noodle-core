import type { RenderedHostPackageFile } from './host-packaging-types.js';

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const UNIX_ZIP_VERSION = (3 << 8) | ZIP_VERSION;
const DOS_DATE_1980_01_01 = 0x0021;
const REGULAR_FILE_MODE = (0o100644 << 16) >>> 0;

interface CentralEntry {
  readonly name: Uint8Array;
  readonly crc32: number;
  readonly byteLength: number;
  readonly localOffset: number;
}

/** Write a stable, store-only ZIP without filesystem timestamps or platform-specific metadata. */
export function deterministicZip(files: readonly RenderedHostPackageFile[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralEntries: CentralEntry[] = [];
  let localOffset = 0;

  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const checksum = crc32(file.content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    header.writeUInt16LE(ZIP_VERSION, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(file.byteLength, 18);
    header.writeUInt32LE(file.byteLength, 22);
    header.writeUInt16LE(name.byteLength, 26);
    header.writeUInt16LE(0, 28);
    localParts.push(header, name, file.content);
    centralEntries.push({
      name,
      crc32: checksum,
      byteLength: file.byteLength,
      localOffset,
    });
    localOffset += header.byteLength + name.byteLength + file.byteLength;
  }

  const centralParts: Uint8Array[] = [];
  let centralSize = 0;
  for (const entry of centralEntries) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    header.writeUInt16LE(UNIX_ZIP_VERSION, 4);
    header.writeUInt16LE(ZIP_VERSION, 6);
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    header.writeUInt32LE(entry.crc32, 16);
    header.writeUInt32LE(entry.byteLength, 20);
    header.writeUInt32LE(entry.byteLength, 24);
    header.writeUInt16LE(entry.name.byteLength, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(REGULAR_FILE_MODE, 38);
    header.writeUInt32LE(entry.localOffset, 42);
    centralParts.push(header, entry.name);
    centralSize += header.byteLength + entry.name.byteLength;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    const tableEntry = CRC32_TABLE[(checksum ^ byte) & 0xff];
    if (tableEntry === undefined) throw new Error('CRC32 table lookup failed.');
    checksum = tableEntry ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC32_TABLE[index] = value >>> 0;
}
