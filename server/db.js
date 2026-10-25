import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { packChunk, unpackChunk } from './chunk-codec.js';

const SCHEMA_VERSION = 3;

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

const MIGRATION_2 = `
CREATE TABLE devices (
  id              TEXT PRIMARY KEY,
  client_key_hash TEXT NOT NULL UNIQUE,
  token_hash      TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL COLLATE NOCASE,
  role            TEXT NOT NULL DEFAULT 'player',
  banned          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_devices_name ON devices(name);

ALTER TABLE worlds ADD COLUMN owner_device TEXT;
ALTER TABLE worlds ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE worlds ADD COLUMN join_code TEXT;
CREATE UNIQUE INDEX idx_worlds_join_code ON worlds(join_code) WHERE join_code IS NOT NULL;

CREATE TABLE world_members (
  world_id     TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  permission   TEXT NOT NULL DEFAULT 'player',
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (world_id, device_id)
);

CREATE TABLE player_state (
  world_id     TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  data_json    TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (world_id, device_id)
);

CREATE TABLE leases (
  world_id   TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 产品决定：设备身份上线前的旧世界直接删除（升级前已自动备份）
DELETE FROM save_staging;
DELETE FROM chunks;
DELETE FROM world_members;
DELETE FROM player_state;
DELETE FROM leases;
DELETE FROM worlds;
`;

const MIGRATION_3 = `
CREATE TABLE block_entities (
  world_id   TEXT NOT NULL,
  x          INTEGER NOT NULL,
  y          INTEGER NOT NULL,
  z          INTEGER NOT NULL,
  type       TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, x, y, z)
);
`;

export class ConflictError extends Error {
  constructor(message = 'revision conflict') { super(message); this.name = 'ConflictError'; this.code = 'CONFLICT_REVISION'; }
}

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'mcjs.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');

  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'").get();
  let current = table ? (db.prepare('SELECT version FROM schema_meta').get()?.version ?? 0) : 0;
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
      current = 1;
    } catch (e) {
      db.exec('ROLLBACK');
      db.close();
      throw e;
    }
  }

  if (current < 2) {
    // destructive migration: keep a copy before deleting legacy worlds
    try {
      const count = db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n;
      if (count > 0) backupNow(db, dataDir, 'pre-v2');
    } catch (e) {
      console.warn('[migrate] pre-v2 backup failed:', e.message);
    }
    db.exec('BEGIN');
    try {
      db.exec(MIGRATION_2);
      db.prepare('UPDATE schema_meta SET version = 2').run();
      db.exec('COMMIT');
      current = 2;
    } catch (e) {
      db.exec('ROLLBACK');
      db.close();
      throw e;
    }
  }

  if (current < 3) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATION_3);
      db.prepare('UPDATE schema_meta SET version = 3').run();
      db.exec('COMMIT');
      current = 3;
    } catch (e) {
      db.exec('ROLLBACK');
      db.close();
      throw e;
    }
  }

  return new Store(db, dataDir);
}

function backupNow(db, dataDir, tag) {
  const dir = path.join(dataDir, 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${tag}-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

// node:sqlite is loaded lazily so tests can pass a :memory: path if needed later.
class Store {
  constructor(db, dataDir) {
    this.db = db;
    this.dataDir = dataDir;
    const q = this.q = {};
    q.listWorldsForDevice = db.prepare(`
      SELECT w.*, m.device_id AS member_device,
        CASE WHEN w.owner_device = ? THEN 'owner'
             WHEN m.device_id IS NOT NULL THEN 'member'
             WHEN w.visibility = 'lan' THEN 'lan' END AS role
      FROM worlds w
      LEFT JOIN world_members m ON m.world_id = w.id AND m.device_id = ?
      WHERE w.deleted_at IS NULL AND (w.owner_device = ? OR m.device_id IS NOT NULL OR w.visibility = 'lan')
      ORDER BY w.last_played DESC`);
    q.getWorld = db.prepare('SELECT * FROM worlds WHERE id = ? AND deleted_at IS NULL');
    q.getWorldByCode = db.prepare('SELECT * FROM worlds WHERE join_code = ? AND deleted_at IS NULL');
    q.insertWorld = db.prepare(`INSERT INTO worlds
      (id,name,seed,mode,flat,time,weather,rain_target,meta_json,revision,created_at,updated_at,last_played,owner_device,visibility,join_code)
      VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`);
    q.renameWorld = db.prepare('UPDATE worlds SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL');
    q.setVisibility = db.prepare('UPDATE worlds SET visibility = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL');
    q.setJoinCode = db.prepare('UPDATE worlds SET join_code = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL');
    q.deleteWorld = db.prepare('UPDATE worlds SET deleted_at = ?, join_code = NULL WHERE id = ? AND deleted_at IS NULL');
    q.updateWorld = db.prepare(`UPDATE worlds SET name=?, time=?, weather=?, rain_target=?, meta_json=?,
      revision=revision+1, updated_at=?, last_played=? WHERE id=? AND revision=? AND deleted_at IS NULL`);
    q.getRevision = db.prepare('SELECT revision, owner_device FROM worlds WHERE id = ? AND deleted_at IS NULL');
    q.getChunkPage = db.prepare('SELECT cx,cz,data FROM chunks WHERE world_id=? ORDER BY cx,cz LIMIT ? OFFSET ?');
    q.getChunk = db.prepare('SELECT cx,cz,data FROM chunks WHERE world_id=? AND cx=? AND cz=?');
    q.putChunk = db.prepare(`INSERT INTO chunks(world_id,cx,cz,data,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(world_id,cx,cz) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`);
    q.listBlockEntities = db.prepare('SELECT x,y,z,type,data_json FROM block_entities WHERE world_id=?');
    q.putBlockEntity = db.prepare(`INSERT INTO block_entities(world_id,x,y,z,type,data_json,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(world_id,x,y,z) DO UPDATE SET type=excluded.type, data_json=excluded.data_json, updated_at=excluded.updated_at`);
    q.deleteBlockEntity = db.prepare('DELETE FROM block_entities WHERE world_id=? AND x=? AND y=? AND z=?');
    q.putStaging = db.prepare(`INSERT INTO save_staging(world_id,save_id,cx,cz,data,created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(world_id,save_id,cx,cz) DO UPDATE SET data=excluded.data, created_at=excluded.created_at`);
    q.countStaging = db.prepare('SELECT COUNT(*) AS n FROM save_staging WHERE world_id=? AND save_id=?');
    q.moveStaging = db.prepare(`INSERT INTO chunks(world_id,cx,cz,data,updated_at)
      SELECT world_id,cx,cz,data,? FROM save_staging WHERE world_id=? AND save_id=?
      ON CONFLICT(world_id,cx,cz) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`);
    q.clearStaging = db.prepare('DELETE FROM save_staging WHERE world_id=? AND save_id=?');
    q.cleanStaging = db.prepare('DELETE FROM save_staging WHERE created_at < ?');

    q.getDevice = db.prepare('SELECT * FROM devices WHERE id = ?');
    q.getDeviceByKey = db.prepare('SELECT * FROM devices WHERE client_key_hash = ?');
    q.getDeviceByToken = db.prepare('SELECT * FROM devices WHERE token_hash = ?');
    q.insertDevice = db.prepare(`INSERT INTO devices(id,client_key_hash,token_hash,name,role,created_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?)`);
    q.updateDeviceToken = db.prepare('UPDATE devices SET token_hash=?, last_seen_at=? WHERE id=?');
    q.touchDevice = db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?');
    q.renameDevice = db.prepare('UPDATE devices SET name=? WHERE id=?');
    q.countDevices = db.prepare('SELECT COUNT(*) AS n FROM devices');
    q.listDevices = db.prepare('SELECT id,name,role,banned,last_seen_at FROM devices ORDER BY created_at');

    q.addMember = db.prepare(`INSERT INTO world_members(world_id,device_id,permission,joined_at) VALUES (?,?,?,?)
      ON CONFLICT(world_id,device_id) DO NOTHING`);
    q.getMember = db.prepare('SELECT * FROM world_members WHERE world_id=? AND device_id=?');
    q.listMembers = db.prepare(`SELECT m.device_id, m.permission, d.name FROM world_members m
      JOIN devices d ON d.id=m.device_id WHERE m.world_id=? ORDER BY m.joined_at`);
    q.removeMember = db.prepare('DELETE FROM world_members WHERE world_id=? AND device_id=?');

    q.getPlayer = db.prepare('SELECT data_json FROM player_state WHERE world_id=? AND device_id=?');
    q.putPlayer = db.prepare(`INSERT INTO player_state(world_id,device_id,data_json,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(world_id,device_id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at`);

    q.getLease = db.prepare(`SELECT l.*, d.name AS holder_name FROM leases l
      LEFT JOIN devices d ON d.id=l.device_id WHERE l.world_id=?`);
    q.putLease = db.prepare(`INSERT INTO leases(world_id,device_id,token_hash,expires_at) VALUES (?,?,?,?)
      ON CONFLICT(world_id) DO UPDATE SET device_id=excluded.device_id, token_hash=excluded.token_hash, expires_at=excluded.expires_at`);
    q.deleteLease = db.prepare('DELETE FROM leases WHERE world_id=?');
    q.deleteLeaseIf = db.prepare('DELETE FROM leases WHERE world_id=? AND device_id=? AND token_hash=?');
    q.cleanLeases = db.prepare('DELETE FROM leases WHERE expires_at < ?');

    this.cleanupStaging();
    this.cleanupLeases();
  }

  close() { this.db.close(); }

  cleanupStaging(now = Date.now()) { this.q.cleanStaging.run(now - 10 * 60 * 1000); }
  cleanupLeases(now = Date.now()) { this.q.cleanLeases.run(now); }

  // ---- devices ------------------------------------------------------------
  getDevice(id) { return this.q.getDevice.get(id) || null; }
  getDeviceByKey(hash) { return this.q.getDeviceByKey.get(hash) || null; }
  getDeviceByToken(hash) { return this.q.getDeviceByToken.get(hash) || null; }
  renameDevice(id, name) { return this.q.renameDevice.run(name, id).changes > 0; }
  touchDevice(id, now = Date.now()) { this.q.touchDevice.run(now, id); }
  countDevices() { return this.q.countDevices.get().n; }
  listDevices() { return this.q.listDevices.all(); }

  createDevice({ id, clientKeyHash, tokenHash, name, role }) {
    const now = Date.now();
    this.q.insertDevice.run(id, clientKeyHash, tokenHash, name, role, now, now);
    return this.getDevice(id);
  }

  rotateDeviceToken(id, tokenHash) {
    const now = Date.now();
    this.q.updateDeviceToken.run(tokenHash, now, id);
    return this.getDevice(id);
  }

  // ---- worlds -------------------------------------------------------------
  listWorldsForDevice(deviceId) {
    return this.q.listWorldsForDevice.all(deviceId, deviceId, deviceId);
  }
  getWorld(id) {
    const row = this.q.getWorld.get(id);
    return row ? parseWorldRow(row) : null;
  }
  getWorldByCode(code) {
    const row = this.q.getWorldByCode.get(code);
    return row ? parseWorldRow(row) : null;
  }
  createWorld(input, deviceId) {
    const now = Date.now();
    const id = 'w' + crypto.randomBytes(9).toString('hex');
    const joinCode = this.newJoinCode();
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
      adv: input.adv || {},
      stats: input.stats || {},
      tutorial: typeof input.tutorial === 'number' ? input.tutorial : (input.mode === 'creative' ? -1 : 0),
      blockEntities: input.blockEntities || {},
      mobs: Array.isArray(input.mobs) ? input.mobs : [],
    };
    const visibility = input.visibility === 'lan' ? 'lan' : 'private';
    this.q.insertWorld.run(id, meta.name, meta.seed, meta.mode, meta.flat ? 1 : 0, meta.time,
      meta.weather, meta.rainTarget, JSON.stringify(meta), meta.created, now, now, deviceId, visibility, joinCode);
    this.q.addMember.run(id, deviceId, 'owner', now);
    return { ...meta, revision: 0, ownerDevice: deviceId, visibility, joinCode, role: 'owner' };
  }

  newJoinCode() {
    const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let tries = 0; tries < 20; tries++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += ABC[crypto.randomInt(ABC.length)];
      if (!this.q.getWorldByCode.get(code)) return code;
    }
    throw new Error('could not allocate join code');
  }

  isMember(worldId, deviceId) { return !!this.q.getMember.get(worldId, deviceId); }
  addMember(worldId, deviceId, permission = 'player') { this.q.addMember.run(worldId, deviceId, permission, Date.now()); }
  listMembers(worldId) { return this.q.listMembers.all(worldId); }
  removeMember(worldId, deviceId) { return this.q.removeMember.run(worldId, deviceId).changes > 0; }

  joinByCode(code, deviceId) {
    const world = this.getWorldByCode(code);
    if (!world) return null;
    this.addMember(world.id, deviceId);
    return this.getWorld(world.id);
  }

  joinLan(worldId, deviceId) {
    const world = this.getWorld(worldId);
    if (!world || world.visibility !== 'lan') return null;
    this.addMember(worldId, deviceId);
    return world;
  }

  renameWorld(id, name) { return this.q.renameWorld.run(name, Date.now(), id).changes > 0; }
  setVisibility(id, visibility) { return this.q.setVisibility.run(visibility, Date.now(), id).changes > 0; }
  regenerateCode(id) { return this.q.setJoinCode.run(this.newJoinCode(), Date.now(), id).changes > 0; }
  deleteWorld(id) { return this.q.deleteWorld.run(Date.now(), id).changes > 0; }

  // ---- player state -------------------------------------------------------
  getPlayerState(worldId, deviceId) {
    const row = this.q.getPlayer.get(worldId, deviceId);
    if (!row) return null;
    try { return JSON.parse(row.data_json); } catch { return null; }
  }
  putPlayerState(worldId, deviceId, data) {
    this.q.putPlayer.run(worldId, deviceId, JSON.stringify(data), Date.now());
  }

  // ---- chunks -------------------------------------------------------------
  getChunkPage(id, cursor = 0, limit = 128) {
    const rows = this.q.getChunkPage.all(id, limit, cursor);
    const next = rows.length === limit ? cursor + rows.length : null;
    return { rows, nextCursor: next };
  }
  getChunksByKeys(id, keys) {
    const rows = [];
    for (const [cx, cz] of keys) {
      const r = this.q.getChunk.get(id, cx, cz);
      if (r) rows.push(r);
    }
    return rows;
  }

  getChunkRow(id, cx, cz) { return this.q.getChunk.get(id, cx, cz) || null; }

  putChunkData(id, cx, cz, blob) {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.q.getChunk.get(id, cx, cz);
      if (!existing) {
        this.db.prepare('INSERT INTO chunks(world_id,cx,cz,data,updated_at) VALUES (?,?,?,?,?)').run(id, cx, cz, blob, now);
      }
      this.db.exec('COMMIT');
      return !existing;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  applyBlock(id, cx, cz, x, y, z, blockId, meta) {
    const row = this.q.getChunk.get(id, cx, cz);
    if (!row) return { ok: false, missing: true };
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y > 255) return { ok: false };
    const { b, m } = unpackChunk(row.data);
    const blocks = decodePairs(b);
    const metas = decodePairs(m);
    const idx = (y << 8) | (z << 4) | x;
    const previous = blocks[idx];
    blocks[idx] = blockId & 0xff;
    metas[idx] = meta & 0xff;
    const data = packChunk({ b: encodePairs(blocks), m: encodePairs(metas) });
    this.q.putChunk.run(id, cx, cz, data, Date.now());
    return { ok: true, previous };
  }

  listBlockEntities(worldId) {
    const out = {};
    for (const r of this.q.listBlockEntities.all(worldId)) {
      try { out[`${r.x},${r.y},${r.z}`] = { type: r.type, ...JSON.parse(r.data_json) }; } catch { /* skip */ }
    }
    return out;
  }

  putBlockEntity(worldId, x, y, z, type, data) {
    this.q.putBlockEntity.run(worldId, x, y, z, type, JSON.stringify(data), Date.now());
  }

  deleteBlockEntity(worldId, x, y, z) {
    this.q.deleteBlockEntity.run(worldId, x, y, z);
  }

  updateWorldClock(id, time, weather, rainTarget) {
    this.db.prepare('UPDATE worlds SET time=?, weather=?, rain_target=?, updated_at=? WHERE id=? AND deleted_at IS NULL')
      .run(time | 0, weather || 0, rainTarget || 0, Date.now(), id);
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
  clearSave(id, saveId) { this.q.clearStaging.run(id, saveId); }

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
      delete fullMeta.player; // player state lives in player_state
      const result = this.q.updateWorld.run(
        name, Number(meta.time) || 0, Number(meta.weather) || 0, Number(meta.rainTarget) || 0,
        JSON.stringify(fullMeta), now, Number(meta.lastPlayed) || now, id, baseRevision,
      );
      if (result.changes === 0) throw new ConflictError();
      this.db.exec('COMMIT');
      return { revision: baseRevision + 1, savedChunks: staged };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- leases -------------------------------------------------------------
  getLease(worldId) { this.cleanupLeases(); return this.q.getLease.get(worldId) || null; }
  putLease(worldId, deviceId, tokenHash, ttlMs = 60_000) {
    this.q.putLease.run(worldId, deviceId, tokenHash, Date.now() + ttlMs);
  }
  deleteLease(worldId) { this.q.deleteLease.run(worldId); }
  deleteLeaseIf(worldId, deviceId, tokenHash) { this.q.deleteLeaseIf.run(worldId, deviceId, tokenHash); }

  backup() {
    const dir = path.join(this.dataDir, 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `mcjs-${stamp}.db`);
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
    while (files.length > 7) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* ignore */ }
    }
    return file;
  }
}

function parseWorldRow(row) {
  let meta = {};
  try { meta = JSON.parse(row.meta_json); } catch { /* tolerant */ }
  const world = {
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
    ownerDevice: row.owner_device,
    visibility: row.visibility,
    joinCode: row.join_code,
  };
  delete world.player;
  return world;
}

export function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64);
}

const CELLS = 16 * 16 * 256;

function decodePairs(buf) {
  const arr = new Uint8Array(CELLS);
  let p = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const v = buf.readUInt16LE(i), n = buf.readUInt16LE(i + 2);
    if (p + n > CELLS) break;
    arr.fill(v, p, p + n);
    p += n;
  }
  return arr;
}

function encodePairs(arr) {
  const out = [];
  let i = 0;
  while (i < arr.length) {
    const v = arr[i];
    let n = 1;
    while (i + n < arr.length && arr[i + n] === v && n < 65535) n++;
    out.push(v, n);
    i += n;
  }
  const buf = Buffer.alloc(out.length * 2);
  for (let k = 0; k < out.length; k++) buf.writeUInt16LE(out[k], k * 2);
  return buf;
}

export const __internal = { SCHEMA_VERSION, cleanName };
