import { config } from './config.js';
import { parseClientChunk, packChunk, chunkToWire, ChunkCodecError } from './chunk-codec.js';
import { ConflictError } from './db.js';

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function createApi(store) {
  return async function handle(req, res, url) {
    try {
      const p = url.pathname;
      if (p === '/api/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, version: 1, backend: 'sqlite' });
      }

      if (p === '/api/worlds' && req.method === 'GET') {
        return json(res, 200, { worlds: store.listWorlds() });
      }
      if (p === '/api/worlds' && req.method === 'POST') {
        const body = await readJson(req);
        const meta = store.createWorld(body || {});
        return json(res, 201, meta);
      }

      let m = p.match(/^\/api\/worlds\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (req.method === 'GET') {
          const meta = store.getWorld(id);
          if (!meta) throw new HttpError(404, 'NOT_FOUND', 'world not found');
          return json(res, 200, meta);
        }
        if (req.method === 'PATCH') {
          const body = await readJson(req);
          if (!store.renameWorld(id, body?.name)) throw new HttpError(404, 'NOT_FOUND', 'world not found');
          return json(res, 200, store.getWorld(id));
        }
        if (req.method === 'DELETE') {
          if (!store.deleteWorld(id)) throw new HttpError(404, 'NOT_FOUND', 'world not found');
          return json(res, 200, { ok: true });
        }
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/chunks$/);
      if (m && req.method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const cursor = Math.max(0, Number(url.searchParams.get('cursor') || 0) | 0);
        const limit = Math.min(256, Math.max(1, Number(url.searchParams.get('limit') || 128) | 0));
        const page = store.getChunkPage(id, cursor, limit);
        if (!page) throw new HttpError(404, 'NOT_FOUND', 'world not found');
        return json(res, 200, {
          chunks: page.rows.map(r => ({ cx: r.cx, cz: r.cz, ...chunkToWire(r.data) })),
          nextCursor: page.nextCursor,
        });
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/chunks\/query$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const body = await readJson(req);
        const keys = validateKeys(body?.keys);
        const rows = store.getChunksByKeys(id, keys);
        if (!rows) throw new HttpError(404, 'NOT_FOUND', 'world not found');
        return json(res, 200, {
          found: rows.map(r => ({ cx: r.cx, cz: r.cz, ...chunkToWire(r.data) })),
          missing: keys.filter(([cx, cz]) => !rows.some(r => r.cx === cx && r.cz === cz)),
        });
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/save\/stage$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        if (!store.getWorld(id)) throw new HttpError(404, 'NOT_FOUND', 'world not found');
        const body = await readJson(req);
        const saveId = validateSaveId(body?.saveId);
        const chunks = body?.chunks;
        if (!Array.isArray(chunks) || chunks.length === 0) throw new HttpError(400, 'BAD_REQUEST', 'chunks required');
        if (chunks.length > config.maxChunkBatch) throw new HttpError(413, 'LIMIT_EXCEEDED', `max ${config.maxChunkBatch} chunks per batch`);
        const parsed = chunks.map(c => {
          const { cx, cz } = validateCoord(c);
          const data = packChunk(parseClientChunk(c));
          return { cx, cz, data };
        });
        store.stageChunks(id, saveId, parsed);
        return json(res, 200, { staged: parsed.length });
      }

      m = p.match(/^\/api\/worlds\/([^/]+)\/save\/commit$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const body = await readJson(req);
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
        const body = await readJson(req);
        store.abortStaging(id, validateSaveId(body?.saveId));
        return json(res, 200, { ok: true });
      }

      throw new HttpError(404, 'NOT_FOUND', 'unknown endpoint');
    } catch (e) {
      if (e instanceof ChunkCodecError) return json(res, 400, { error: { code: 'BAD_CHUNK', message: e.message } });
      if (e instanceof ConflictError) return json(res, 409, { error: { code: 'CONFLICT_REVISION', message: 'world revision changed' } });
      if (e instanceof HttpError) return json(res, e.status, { error: { code: e.code, message: e.message } });
      if (e?.code === 'NOT_FOUND') return json(res, 404, { error: { code: 'NOT_FOUND', message: e.message } });
      console.error('[api]', e);
      return json(res, 500, { error: { code: 'INTERNAL', message: 'internal server error' } });
    }
  };
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
