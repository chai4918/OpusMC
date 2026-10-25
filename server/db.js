import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA_VERSION = 1;

const MIGRATION_1 = `
CREATE TABLE worlds (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  seed          TEXT NOT NULL,
  mode          TEXT NOT NULL,
  flat          INTEGER NOT NULL DEFAULT 0,
  time          INTEGER NOT NULL DEFAULT 1000,
  weather       REAL NOT NULL DEFAULT 0,
  rain_target   REAL NOT NULL DEFAULT 0,
  meta_json     TEXT NOT NULL DEFAULT '{}',
  revision      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_played   INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX idx_worlds_played ON worlds(deleted_at, last_played);

CREATE TABLE chunks (
  world_id   TEXT NOT NULL,
  cx         INTEGER NOT NULL,
  cz         INTEGER NOT NULL,
  data       BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, cx, cz)
);

CREATE TABLE save_staging (
  world_id   TEXT NOT NULL,
  save_id    TEXT NOT NULL,
  cx         INTEGER NOT NULL,
  cz         INTEGER NOT NULL,
  data       BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, save_id, cx, cz)
);
CREATE INDEX idx_staging_age ON save_staging(created_at);

CREATE TABLE schema_meta (version INTEGER NOT NULL);
`;

export class ConflictError extends Error {
  constructor(message = 'revision conflict') { super(message); this.name = 'ConflictError'; this.code = 'CONFLICT_REVISION'; }
}

export function openDb(dataDir = config.dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'mcjs.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');

  const versionRow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'").get();
  const current = versionRow ? db.prepare('SELECT version FROM schema_meta').get()?.version : 0;
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(`database schema ${current} is newer than supported ${SCHEMA_VERSION}`);
  }
  if (current < 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATION_1);
      db.prepare('INSERT INTO schema_meta(version) VALUES (1)').run();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      db.close();
      throw e;
    }
  }

  return new Store(db, dataDir);
}

class Store {
  constructor(db, dataDir) {
    this.db = db;
    this.dataDir = dataDir;
    this.q = {
      listWorlds: db.prepare(`SELECT id,name,seed,mode,flat,time,revision,created_at,updated_at,last_played
                              FROM worlds WHERE deleted_at IS NULL ORDER BY last_played DESC`),
      getWorld: db.prepare('SELECT * FROM worlds WHERE id = ? AND deleted_at IS NULL'),
      insertWorld: db.prepare(`INSERT INTO worlds
        (id,name,seed,mode,flat,time,weather,rain_target,meta_json,revision,created_at,updated_at,last_played)
        VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)`),
      renameWorld: db.prepare('UPDATE worlds SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'),
      deleteWorld: db.prepare('UPDATE worlds SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
      updateWorld: db.prepare(`UPDATE worlds SET name=?, time=?, weather=?, rain_target=?, meta_json=?,
        revision=revision+1, updated_at=?, last_played=? WHERE id=? AND revision=? AND deleted_at IS NULL`),
      getRevision: db.prepare('SELECT revision FROM worlds WHERE id = ? AND deleted_at IS NULL'),
      getChunkPage: db.prepare('SELECT cx,cz,data FROM chunks WHERE world_id=? ORDER BY cx,cz LIMIT ? OFFSET ?'),
      getChunk: db.prepare('SELECT cx,cz,data FROM chunks WHERE world_id=? AND cx=? AND cz=?'),
      putChunk: db.prepare(`INSERT INTO chunks(world_id,cx,cz,data,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(world_id,cx,cz) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`),
      putStaging: db.prepare(`INSERT INTO save_staging(world_id,save_id,cx,cz,data,created_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(world_id,save_id,cx,cz) DO UPDATE SET data=excluded.data, created_at=excluded.created_at`),
      countStaging: db.prepare('SELECT COUNT(*) AS n FROM save_staging WHERE world_id=? AND save_id=?'),
      moveStaging: db.prepare(`INSERT INTO chunks(world_id,cx,cz,data,updated_at)
        SELECT world_id,cx,cz,data,? FROM save_staging WHERE world_id=? AND save_id=?
        ON CONFLICT(world_id,cx,cz) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`),
      clearStaging: db.prepare('DELETE FROM save_staging WHERE world_id=? AND save_id=?'),
      abortStaging: db.prepare('DELETE FROM save_staging WHERE world_id=? AND save_id=?'),
      cleanStaging: db.prepare('DELETE FROM save_staging WHERE created_at < ?'),
    };
    this.cleanupStaging();
  }

  close() { this.db.close(); }

  cleanupStaging(now = Date.now()) {
    this.q.cleanStaging.run(now - config.stagingTtlMs);
  }

  listWorlds() { return this.q.listWorlds.all(); }

  getWorld(id) {
    const row = this.q.getWorld.get(id);
    return row ? parseWorldRow(row) : null;
  }

  createWorld(input) {
    const now = Date.now();
    const id = 'w' + crypto.randomBytes(9).toString('hex');
    const meta = {
      id,
      name: cleanName(input.name) || '新的世界',
      seed: String(input.seed ?? ''),
      mode: input.mode === 'creative' ? 'creative' : 'survival',
      flat: input.flat ? 1 : 0,
      created: Number(input.created) || now,
      lastPlayed: now,
      time: Number(input.time) || 1000,
      weather: Number(input.weather) || 0,
      rainTarget: Number(input.rainTarget) || 0,
      spawn: Array.isArray(input.spawn) ? input.spawn : null,
      player: input.player || null,
      adv: input.adv || {},
      stats: input.stats || {},
      tutorial: typeof input.tutorial === 'number' ? input.tutorial : (input.mode === 'creative' ? -1 : 0),
      blockEntities: input.blockEntities || {},
      mobs: Array.isArray(input.mobs) ? input.mobs : [],
    };
    meta.revision = 0;
    this.q.insertWorld.run(id, meta.name, meta.seed, meta.mode, meta.flat ? 1 : 0, meta.time,
      meta.weather, meta.rainTarget, JSON.stringify(meta), meta.created, now, now);
    return { ...meta, revision: 0 };
  }

  renameWorld(id, name) {
    const n = cleanName(name);
    if (!n) return false;
    return this.q.renameWorld.run(n, Date.now(), id).changes > 0;
  }

  deleteWorld(id) {
    return this.q.deleteWorld.run(Date.now(), id).changes > 0;
  }

  getChunkPage(id, cursor = 0, limit = 128) {
    if (!this.getWorld(id)) return null;
    const rows = this.q.getChunkPage.all(id, limit, cursor);
    const next = rows.length === limit ? cursor + rows.length : null;
    return { rows, nextCursor: next };
  }

  getChunksByKeys(id, keys) {
    if (!this.getWorld(id)) return null;
    const rows = [];
    for (const [cx, cz] of keys) {
      const r = this.q.getChunk.get(id, cx, cz);
      if (r) rows.push(r);
    }
    return rows;
  }

  stageChunks(id, saveId, chunks, now = Date.now()) {
    this.cleanupStaging(now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of chunks) this.q.putStaging.run(id, saveId, c.cx, c.cz, c.data, now);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  abortStaging(id, saveId) {
    this.q.abortStaging.run(id, saveId);
  }

  commitSave(id, saveId, baseRevision, meta) {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.q.getRevision.get(id);
      if (!current) throw Object.assign(new Error('world not found'), { code: 'NOT_FOUND', status: 404 });
      if (current.revision !== baseRevision) throw new ConflictError();
      const staged = this.q.countStaging.get(id, saveId).n;
      this.q.moveStaging.run(now, id, saveId);
      this.q.clearStaging.run(id, saveId);

      const name = cleanName(meta.name) || '新的世界';
      const fullMeta = { ...meta, id, revision: baseRevision + 1 };
      const result = this.q.updateWorld.run(
        name,
        Number(meta.time) || 0,
        Number(meta.weather) || 0,
        Number(meta.rainTarget) || 0,
        JSON.stringify(fullMeta),
        now,
        Number(meta.lastPlayed) || now,
        id,
        baseRevision,
      );
      if (result.changes === 0) throw new ConflictError();
      this.db.exec('COMMIT');
      return { revision: baseRevision + 1, savedChunks: staged };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  backup() {
    const dir = path.join(this.dataDir, 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `mcjs-${stamp}.db`);
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
    while (files.length > config.backupKeep) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* ignore */ }
    }
    return file;
  }
}

function parseWorldRow(row) {
  let meta = {};
  try { meta = JSON.parse(row.meta_json); } catch { /* tolerante */ }
  return {
    ...meta,
    id: row.id,
    name: row.name,
    seed: row.seed,
    mode: row.mode,
    flat: !!row.flat,
    time: row.time,
    weather: row.weather,
    rainTarget: row.rain_target,
    revision: row.revision,
    created: row.created_at,
    lastPlayed: row.last_played,
  };
}

function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64);
}

export const __internal = { SCHEMA_VERSION, cleanName };
