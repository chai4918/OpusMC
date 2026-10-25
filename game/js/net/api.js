'use strict';
// ---------------------------------------------------------------------------
// Minimal JSON client for the authoritative storage server (same-origin /api).
// Classic script: exposed as window.MCNet so it can be used before ES modules.
// ---------------------------------------------------------------------------
(function () {
  const BASE = '/api';

  async function request(method, path, body, timeoutMs = 20000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { /* fall through */ } }
      if (!res.ok) {
        const err = new Error(data?.error?.message || res.statusText || 'request failed');
        err.code = data?.error?.code || 'HTTP_' + res.status;
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') {
        const err = new Error('服务器响应超时');
        err.code = 'TIMEOUT';
        throw err;
      }
      if (e.code) throw e;
      const err = new Error('无法连接服务器');
      err.code = 'NETWORK';
      err.cause = e;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function u16ToB64(values) {
    const u16 = values instanceof Uint16Array ? values : Uint16Array.from(values || []);
    const bytes = new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  function b64ToU16(b64) {
    const bin = atob(String(b64 || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Uint16Array(bytes.buffer, 0, bytes.length >> 1);
  }

  let seq = 0;
  function newSaveId() {
    const r = (crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).slice(2));
    return 's' + r + (seq++).toString(36);
  }

  window.MCNet = {
    available: false,
    u16ToB64,
    b64ToU16,
    newSaveId,
    async health(timeoutMs = 1500) { return request('GET', '/health', undefined, timeoutMs); },
    listWorlds() { return request('GET', '/worlds'); },
    createWorld(meta) { return request('POST', '/worlds', meta); },
    getWorld(id) { return request('GET', '/worlds/' + encodeURIComponent(id)); },
    renameWorld(id, name) { return request('PATCH', '/worlds/' + encodeURIComponent(id), { name }); },
    deleteWorld(id) { return request('DELETE', '/worlds/' + encodeURIComponent(id)); },
    getChunks(id, cursor = 0, limit = 128) {
      return request('GET', `/worlds/${encodeURIComponent(id)}/chunks?cursor=${cursor}&limit=${limit}`);
    },
    async stageChunks(id, saveId, chunks) {
      return request('POST', `/worlds/${encodeURIComponent(id)}/save/stage`, {
        saveId,
        chunks: chunks.map(([cx, cz, rec]) => ({ cx, cz, b: u16ToB64(rec.b), m: u16ToB64(rec.m) })),
      });
    },
    commit(id, saveId, baseRevision, meta) {
      return request('POST', `/worlds/${encodeURIComponent(id)}/save/commit`, { saveId, baseRevision, meta });
    },
    abort(id, saveId) { return request('POST', `/worlds/${encodeURIComponent(id)}/save/abort`, { saveId }); },
  };
})();
