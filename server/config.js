import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  gameDir: path.join(root, 'game'),
  dataDir: process.env.MC_DATA_DIR || path.join(root, 'data'),
  host: process.env.MC_HOST || '0.0.0.0',
  port: Number(process.env.MC_PORT || 8765),
  // limits
  maxBodyBytes: 8 * 1024 * 1024,
  maxChunkBatch: 64,
  maxQueryKeys: 256,
  maxMetaBytes: 1024 * 1024,
  maxChunkPairs: 65536,
  stagingTtlMs: 10 * 60 * 1000,
  backupIntervalMs: 6 * 60 * 60 * 1000,
  backupKeep: 7,
};
