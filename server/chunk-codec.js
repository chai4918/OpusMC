// Chunk codec for the standalone storage server.
//
// Wire format (both client and server): two base64 strings, each holding a
// Uint16 little-endian RLE array: [value, count, value, count, ...].
// The decoded sum of counts must be 65536 (16 * 16 * 256).
//
// Storage format (SQLite BLOB): u32 blockBytes | u32 metaBytes | blockData | metaData.

export const CHUNK_CELLS = 16 * 16 * 256;
const MAX_BYTES = CHUNK_CELLS * 2 * 2; // worst case: every cell is its own run

export class ChunkCodecError extends Error {
  constructor(message) { super(message); this.name = 'ChunkCodecError'; }
}

function validatePairs(buf, label) {
  if (buf.length % 4 !== 0) throw new ChunkCodecError(`${label}: length must be a multiple of 4 bytes`);
  if (buf.length > MAX_BYTES) throw new ChunkCodecError(`${label}: too large`);
  let cells = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const value = buf.readUInt16LE(i);
    const count = buf.readUInt16LE(i + 2);
    if (value > 255) throw new ChunkCodecError(`${label}: value out of range`);
    if (count === 0) throw new ChunkCodecError(`${label}: zero-length run`);
    cells += count;
    if (cells > CHUNK_CELLS) throw new ChunkCodecError(`${label}: too many cells`);
  }
  if (cells !== CHUNK_CELLS) throw new ChunkCodecError(`${label}: expected ${CHUNK_CELLS} cells, got ${cells}`);
}

export function parseClientChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') throw new ChunkCodecError('chunk must be an object');
  const b = Buffer.from(String(chunk.b || ''), 'base64');
  const m = Buffer.from(String(chunk.m || ''), 'base64');
  validatePairs(b, 'blocks');
  validatePairs(m, 'meta');
  return { b, m };
}

export function packChunk({ b, m }) {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32LE(b.length, 0);
  head.writeUInt32LE(m.length, 4);
  return Buffer.concat([head, b, m]);
}

export function unpackChunk(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (!buf || buf.length < 8) throw new ChunkCodecError('stored chunk is truncated');
  const bLen = buf.readUInt32LE(0);
  const mLen = buf.readUInt32LE(4);
  if (bLen + mLen + 8 !== buf.length) throw new ChunkCodecError('stored chunk length mismatch');
  return { b: buf.subarray(8, 8 + bLen), m: buf.subarray(8 + bLen) };
}

export function chunkToWire(blob) {
  const { b, m } = unpackChunk(blob);
  return { b: b.toString('base64'), m: m.toString('base64') };
}
