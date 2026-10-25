import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db.js';

const V1 = `
CREATE TABLE worlds (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, seed TEXT NOT NULL, mode TEXT NOT NULL,
  flat INTEGER NOT NULL DEFAULT 0, time INTEGER NOT NULL DEFAULT 1000,
  weather REAL NOT NULL DEFAULT 0, rain_target REAL NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_played INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE chunks (
  world_id TEXT NOT NULL, cx INTEGER NOT NULL, cz INTEGER NOT NULL,
  data BLOB NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (world_id, cx, cz)
);
CREATE TABLE save_staging (
  world_id TEXT NOT NULL, save_id TEXT NOT NULL, cx INTEGER NOT NULL, cz INTEGER NOT NULL,
  data BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (world_id, save_id, cx, cz)
);
CREATE TABLE schema_meta (version INTEGER NOT NULL);
`;

test('v2 migration backs up and deletes legacy worlds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcjs-migrate-'));
  try {
    const db = new DatabaseSync(path.join(dir, 'mcjs.db'));
    db.exec(V1);
    db.prepare('INSERT INTO schema_meta(version) VALUES (1)').run();
    const now = Date.now();
    db.prepare(`INSERT INTO worlds(id,name,seed,mode,flat,time,weather,rain_target,meta_json,revision,created_at,updated_at,last_played)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('wlegacy', '旧世界', '1', 'survival', 0, 1000, 0, 0, '{}', 0, now, now, now);
    db.prepare('INSERT INTO chunks(world_id,cx,cz,data,updated_at) VALUES (?,?,?,?,?)').run('wlegacy', 0, 0, Buffer.from([1]), now);
    db.close();

    const store = openDb(dir);
    assert.equal(store.listWorldsForDevice('d0').length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM save_staging').get().n, 0);
    const backups = fs.readdirSync(path.join(dir, 'backup'));
    assert.ok(backups.some(f => f.startsWith('pre-v2')), 'backup should exist');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
