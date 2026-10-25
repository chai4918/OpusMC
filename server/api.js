import crypto from 'node:crypto';
import { config } from './config.js';
import { parseClientChunk, packChunk, chunkToWire, ChunkCodecError } from './chunk-codec.js';
import { ConflictError } from './db.js';
import {
  authenticate, setDeviceCookie, clearDeviceCookie, sha256, newToken, newDeviceId,
  validClientKey, validDeviceName,
} from './auth.js';

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message); this.status = status; this.code = code; this.extra = extra;
  }
}

const joinAttempts = new Map();

export function createApi(store) {
  return async function handle(req, res, url) {
    try {
      const p = url.pathname;

      if (p === '/api/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, version: 3, backend: 'sqlite' });
      }

      if (p === '/api/device' && req.method === 'POST') {
        return await bootstrapDevice(req, res, store);
      }

      const device = authenticate(req, store);
      if (!device) throw new HttpError(401, 'UNAUTHENTICATED', 'device cookie required');

      if (p === '/api/me' && req.method === 'GET') {
        return json(res, 200, { device: publicDevice(device), isAdmin: device.role === 'admin' });
      }
      if (p === '/api/device' && req.method === 'PATCH') {
        const body = await readJson(req);
        const name = validDeviceName(body?.name);
        if (!name) throw new HttpError(400, 'BAD_REQUEST', '昵称需为 2–16 个字符');
        try { store.renameDevice(device.id, name); }
        catch { throw new HttpError(409, 'NAME_TAKEN', '昵称已被占用'); }
        return json(res, 200, { device: publicDevice(store.getDevice(device.id)) });
      }

      if (p === '/api/worlds' && req.method === 'GET') {
        const rows = store.listWorldsForDevice(device.id);
        return json(res, 200, { worlds: rows.map(r => worldForList(r, device.id)) });
      }
      if (p === '/api/worlds' && req.method === 'POST') {
        const body = await readJson(req);
        const world = store.createWorld(body || {}, device.id);
        return json(res, 201, world);
      }
      if (p === '/api/worlds/join' && req.method === 'POST') {
        const body = await readJson(req);
        const code = String(body?.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) throw new HttpError(400, 'BAD_REQUEST', '加入码格式不正确');
        limitJoinAttempts(device.id);
        const world = store.joinByCode(code, device.id);
        if (!world) throw new HttpError(404, 'INVALID_JOIN_CODE', '加入码无效');
        return json(res, 200, worldForDevice(world, device.id));
      }

      let m = p.match(/^\/api\/worlds\/([^/]+)\/join$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const world = store.joinLan(id, device.id);
        if (!world) throw new HttpError(403, 'FORBIDDEN', '该世界未开放局域网加入');
        return json(res, 200, worldForDevice(world, device.id));
      }

      m = p.match(/^\/api\/worlds\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const world = store.getWorld(id);
        if (!world) throw new HttpError(404, 'NOT_FOUND', 'world not found');
        const member = store.isMember(id, device.id);
        if (req.method === 'GET') {
          if (!member && world.visibility !== 'lan') throw new HttpError(403, 'NOT_MEMBER', '不是该世界的成员');
          return json(res, 200, {
            ...worldForDevice(world, device.id, member),
            playerState: store.getPlayerState(id, device.id),
            members: member ? store.listMembers(id) : undefined,
          });
        }
        if (world.ownerDevice !== device.id) throw new HttpError(403, 'FORBIDDEN', '只有房主可以修改世界');
        if (req.method === 'PATCH') {
          const body = await readJson(req);
          if (typeof body?.name === 'string') {
            const name = String(body.name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64);
            if (name) store.renameWorld(id, name);
          }
          if (body?.visibility === 'private' || body?.visibility === 'lan') store.setVisibility(id, body.visibility);
          if (body?.regenerateCode) store.regenerateCode(id);
          return json(res, 200, store.getWorld(id));
        }
        if (req.method === 'DELETE') {
          store.deleteWorld(id);
          store.deleteLease(id);
          return json(res, 200, { ok: true });
        }
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/kick$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const world = requireWorld(store, id);
        if (world.ownerDevice !== device.id) throw new HttpError(403, 'FORBIDDEN', '只有房主可以踢人');
        const body = await readJson(req);
        const target = String(body?.deviceId || '');
        if (!target || target === device.id) throw new HttpError(400, 'BAD_REQUEST', 'invalid target');
        store.removeMember(id, target);
        const lease = store.getLease(id);
        if (lease && lease.device_id === target) store.deleteLease(id);
        return json(res, 200, { ok: true, members: store.listMembers(id) });
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/player$/);
      if (m && req.method === 'PUT') {
        const id = decodeURIComponent(m[1]);
        requireMember(store, id, device.id);
        const body = await readJson(req);
        const data = body?.data;
        if (!data || typeof data !== 'object') throw new HttpError(400, 'BAD_REQUEST', 'data required');
        if (JSON.stringify(data).length > 256 * 1024) throw new HttpError(413, 'LIMIT_EXCEEDED', 'player state too large');
        store.putPlayerState(id, device.id, data);
        return json(res, 200, { ok: true, updatedAt: Date.now() });
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/lease$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        requireMember(store, id, device.id);
        const body = await readJson(req);
        const takeover = !!body?.takeover;
        const existing = store.getLease(id);
        if (existing && existing.device_id !== device.id && existing.expires_at > Date.now()) {
          if (!takeover) {
            throw new HttpError(409, 'LEASE_HELD', `世界正在 ${existing.holder_name || '其他设备'} 上运行`, {
              holderName: existing.holder_name, expiresAt: existing.expires_at,
            });
          }
        }
        const token = newToken();
        store.putLease(id, device.id, sha256(token));
        return json(res, 200, { token, expiresAt: Date.now() + 60_000 });
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/lease\/heartbeat$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const body = await readJson(req);
        const lease = requireLease(store, id, device.id, body?.token);
        store.putLease(id, device.id, lease.token_hash);
        return json(res, 200, { expiresAt: Date.now() + 60_000 });
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/lease\/release$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const body = await readJson(req);
        if (body?.token) store.deleteLeaseIf(id, device.id, sha256(body.token));
        return json(res, 200, { ok: true });
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/block-entities$/);
      if (m && req.method === 'GET') {
        const id = decodeURIComponent(m[1]);
        requireMember(store, id, device.id);
        return json(res, 200, { entities: store.listBlockEntities(id) });
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/chunks$/);
      if (m && req.method === 'GET') {
        const id = decodeURIComponent(m[1]);
        requireMember(store, id, device.id);
        const cursor = Math.max(0, Number(url.searchParams.get('cursor') || 0) | 0);
        const limit = Math.min(256, Math.max(1, Number(url.searchParams.get('limit') || 128) | 0));
        const page = store.getChunkPage(id, cursor, limit);
        return json(res, 200, {
          chunks: page.rows.map(r => ({ cx: r.cx, cz: r.cz, ...chunkToWire(r.data) })),
          nextCursor: page.nextCursor,
        });
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/chunks\/query$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        requireMember(store, id, device.id);
        const body = await readJson(req);
        const keys = validateKeys(body?.keys);
        const rows = store.getChunksByKeys(id, keys);
        return json(res, 200, {
          found: rows.map(r => ({ cx: r.cx, cz: r.cz, ...chunkToWire(r.data) })),
          missing: keys.filter(([cx, cz]) => !rows.some(r => r.cx === cx && r.cz === cz)),
        });
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/save\/stage$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        requireMember(store, id, device.id);
        const body = await readJson(req);
        requireLease(store, id, device.id, body?.leaseToken);
        const saveId = validateSaveId(body?.saveId);
        const chunks = body?.chunks;
        if (!Array.isArray(chunks) || chunks.length === 0) throw new HttpError(400, 'BAD_REQUEST', 'chunks required');
        if (chunks.length > config.maxChunkBatch) throw new HttpError(413, 'LIMIT_EXCEEDED', `max ${config.maxChunkBatch} chunks per batch`);
        const parsed = chunks.map(c => {
          const { cx, cz } = validateCoord(c);
          return { cx, cz, data: packChunk(parseClientChunk(c)) };
        });
        store.stageChunks(id, saveId, parsed);
        return json(res, 200, { staged: parsed.length });
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/save\/commit$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        requireMember(store, id, device.id);
        const body = await readJson(req);
        requireLease(store, id, device.id, body?.leaseToken);
        const saveId = validateSaveId(body?.saveId);
        const baseRevision = Number(body?.baseRevision);
        if (!Number.isInteger(baseRevision) || baseRevision < 0) throw new HttpError(400, 'BAD_REQUEST', 'invalid baseRevision');
        const meta = body?.meta;
        if (!meta || typeof meta !== 'object') throw new HttpError(400, 'BAD_REQUEST', 'meta required');
        if (JSON.stringify(meta).length > config.maxMetaBytes) throw new HttpError(413, 'LIMIT_EXCEEDED', 'meta too large');
        const result = store.commitSave(id, saveId, baseRevision, meta);
        return json(res, 200, result);
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/save\/abort$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        requireMember(store, id, device.id);
        const body = await readJson(req);
        store.clearSave(id, validateSaveId(body?.saveId));
        return json(res, 200, { ok: true });
      }

      throw new HttpError(404, 'NOT_FOUND', 'unknown endpoint');
    } catch (e) {
      if (e instanceof ChunkCodecError) return json(res, 400, { error: { code: 'BAD_CHUNK', message: e.message } });
      if (e instanceof ConflictError) return json(res, 409, { error: { code: 'CONFLICT_REVISION', message: 'world revision changed' } });
      if (e instanceof HttpError) {
        return json(res, e.status, { error: { code: e.code, message: e.message, ...(e.extra || {}) } });
      }
      if (e?.code === 'NOT_FOUND') return json(res, 404, { error: { code: 'NOT_FOUND', message: e.message } });
      console.error('[api]', e);
      return json(res, 500, { error: { code: 'INTERNAL', message: 'internal server error' } });
    }
  };
}

async function bootstrapDevice(req, res, store) {
  const body = await readJson(req);
  const clientKey = String(body?.clientKey || '');
  if (!validClientKey(clientKey)) throw new HttpError(400, 'BAD_REQUEST', 'invalid clientKey');
  const keyHash = sha256(clientKey);
  let device = store.getDeviceByKey(keyHash);
  if (device) {
    if (device.banned) throw new HttpError(403, 'DEVICE_BANNED', '设备已被禁用');
    const token = newToken();
    device = store.rotateDeviceToken(device.id, sha256(token));
    setDeviceCookie(req, res, token);
    return json(res, 200, { device: publicDevice(device), isNew: false });
  }

  const name = validDeviceName(body?.name) || defaultName(store);
  const token = newToken();
  try {
    device = store.createDevice({
      id: newDeviceId(),
      clientKeyHash: keyHash,
      tokenHash: sha256(token),
      name,
      role: store.countDevices() === 0 ? 'admin' : 'player',
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'NAME_TAKEN', '昵称已被占用');
    throw e;
  }
  setDeviceCookie(req, res, token);
  return json(res, 200, { device: publicDevice(device), isNew: true });
}

function defaultName(store) {
  for (let i = 0; i < 50; i++) {
    const name = '玩家-' + crypto.randomBytes(2).toString('hex').toUpperCase();
    try {
      if (!store.db.prepare('SELECT 1 FROM devices WHERE name = ?').get(name)) return name;
    } catch { /* fall through */ }
  }
  return '玩家-' + Date.now().toString(36).toUpperCase();
}

function publicDevice(d) {
  return { id: d.id, name: d.name, role: d.role, createdAt: d.created_at };
}

function worldForList(row, deviceId) {
  return {
    id: row.id, name: row.name, seed: row.seed, mode: row.mode, flat: !!row.flat,
    lastPlayed: row.last_played, revision: row.revision, created: row.created_at,
    ownerDevice: row.owner_device, visibility: row.visibility,
    role: row.role || (row.owner_device === deviceId ? 'owner' : 'member'),
    joinCode: row.role === 'owner' ? row.join_code : undefined,
  };
}

function worldForDevice(world, deviceId, isMember = true) {
  const w = { ...world, role: world.ownerDevice === deviceId ? 'owner' : (isMember ? 'member' : 'lan') };
  if (w.role !== 'owner') delete w.joinCode;
  return w;
}

function requireWorld(store, id) {
  const world = store.getWorld(id);
  if (!world) throw new HttpError(404, 'NOT_FOUND', 'world not found');
  return world;
}

function requireMember(store, id, deviceId) {
  const world = requireWorld(store, id);
  if (!store.isMember(id, deviceId)) throw new HttpError(403, 'NOT_MEMBER', '不是该世界的成员');
  return world;
}

function requireLease(store, id, deviceId, token) {
  const lease = store.getLease(id);
  if (!lease || lease.device_id !== deviceId || lease.expires_at <= Date.now() || lease.token_hash !== sha256(String(token || ''))) {
    throw new HttpError(409, 'LEASE_LOST', '世界已被其他设备接管或租约已过期');
  }
  return lease;
}

function limitJoinAttempts(deviceId) {
  const now = Date.now();
  const rec = joinAttempts.get(deviceId);
  if (!rec || now - rec.ts > 10 * 60 * 1000) {
    joinAttempts.set(deviceId, { count: 1, ts: now });
    return;
  }
  rec.count++;
  if (rec.count > 10) throw new HttpError(429, 'RATE_LIMITED', '尝试过于频繁，请稍后再试');
}

function validateSaveId(v) {
  const s = String(v || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(s)) throw new HttpError(400, 'BAD_REQUEST', 'invalid saveId');
  return s;
}

const COORD_LIMIT = 1_000_000;
function validateCoord(c) {
  const cx = Number(c?.cx), cz = Number(c?.cz);
  if (!Number.isInteger(cx) || !Number.isInteger(cz) || Math.abs(cx) > COORD_LIMIT || Math.abs(cz) > COORD_LIMIT) {
    throw new HttpError(400, 'BAD_REQUEST', 'invalid chunk coordinates');
  }
  return { cx, cz };
}

function validateKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) throw new HttpError(400, 'BAD_REQUEST', 'keys required');
  if (keys.length > config.maxQueryKeys) throw new HttpError(413, 'LIMIT_EXCEEDED', `max ${config.maxQueryKeys} keys`);
  return keys.map(k => {
    if (!Array.isArray(k) || k.length !== 2) throw new HttpError(400, 'BAD_REQUEST', 'invalid key');
    const cx = Number(k[0]), cz = Number(k[1]);
    if (!Number.isInteger(cx) || !Number.isInteger(cz) || Math.abs(cx) > COORD_LIMIT || Math.abs(cz) > COORD_LIMIT) {
      throw new HttpError(400, 'BAD_REQUEST', 'invalid key');
    }
    return [cx, cz];
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const parts = [];
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        failed = true;
        reject(new HttpError(413, 'LIMIT_EXCEEDED', 'request body too large'));
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      if (!parts.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
      catch { reject(new HttpError(400, 'BAD_REQUEST', 'invalid JSON')); }
    });
    req.on('error', (e) => { if (!failed) reject(e); });
  });
}

function json(res, status, body) {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

export { clearDeviceCookie };
