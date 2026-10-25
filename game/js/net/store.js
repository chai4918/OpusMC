'use strict';
// ---------------------------------------------------------------------------
// Storage facade: local IndexedDB (offline) or the authoritative server.
// Device identity is handled here; no accounts/passwords.
// Exposed as window.MCStore (classic script).
// ---------------------------------------------------------------------------
(function () {
  const CLIENT_KEY = 'mcjs-client-key';
  const FORCE_LOCAL = 'mcjs-force-local';
  const IMPORT_FLAG = 'mcjs-imported:';

  function ensureClientKey() {
    let key = localStorage.getItem(CLIENT_KEY);
    if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      key = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(CLIENT_KEY, key);
    }
    return key;
  }

  const Store = {
    mode: 'local',
    online: false,
    reason: '',
    backend: 'memory',
    device: null,
    lease: null,          // { worldId, token, timer }
    onLeaseLost: null,    // set by Game

    async init() {
      await DB.open();
      this.backend = DB.backend;
      this.online = false;
      this.mode = 'local';
      this.reason = '';
      this.device = null;
      if (localStorage.getItem(FORCE_LOCAL) === '1') { this.reason = '已强制本机模式'; return; }
      if (location.protocol === 'file:') { this.reason = 'file:// 下无法连接服务器'; return; }
      try {
        const h = await MCNet.health();
        if (!h || !h.ok) { this.reason = '服务器不可用'; return; }
        // Bootstrap first: the clientKey identifies this device, and the server
        // rotates the cookie token. Avoids a noisy 401 from /me on first visit.
        const r = await MCNet.bootstrapDevice(ensureClientKey());
        this.device = r.device;
        this.online = true;
        this.mode = 'remote';
      } catch (e) {
        this.reason = e.code === 'NETWORK' ? '未连接服务器' : (e.message || '服务器不可用');
      }
    },

    statusText() {
      if (this.online) return '云存档 · ' + (this.device?.name || '玩家');
      return '本机存档' + (this.reason ? ' · ' + this.reason : '');
    },

    displayName() { return this.device?.name || '本机玩家'; },

    useLocal() { localStorage.setItem(FORCE_LOCAL, '1'); location.reload(); },
    useServer() { localStorage.removeItem(FORCE_LOCAL); location.reload(); },

    async renameDevice(name) {
      if (!this.online) return null;
      const r = await MCNet.renameDevice(name);
      this.device = r.device;
      return r.device;
    },

    async listWorlds() {
      if (this.online) {
        const r = await MCNet.listWorlds();
        return (r.worlds || []).map(w => ({ ...w, origin: 'remote' }));
      }
      const worlds = await DB.listWorlds();
      return worlds.map(w => ({ ...w, origin: 'local', role: 'owner' }));
    },

    async getWorld(id) {
      if (this.online) {
        const meta = await MCNet.getWorld(id);
        meta.player = meta.playerState || null;
        return meta;
      }
      return DB.getWorld(id);
    },

    async createWorld(meta) {
      if (this.online) return MCNet.createWorld(meta);
      const now = Date.now();
      const world = {
        id: 'w' + now.toString(36) + Math.random().toString(36).slice(2, 6),
        name: meta.name || '新的世界',
        seed: String(meta.seed ?? ''),
        mode: meta.mode === 'creative' ? 'creative' : 'survival',
        flat: !!meta.flat,
        created: now, lastPlayed: now, time: 1000, weather: 0, rainTarget: 0,
        spawn: null, player: null, adv: {}, stats: { kills: 0, placed: 0, mined: 0 },
        tutorial: meta.mode === 'creative' ? -1 : 0,
        blockEntities: {}, mobs: [], revision: 0, origin: 'local',
        visibility: meta.visibility === 'lan' ? 'lan' : 'private',
        role: 'owner',
      };
      await DB.putWorld(world);
      return world;
    },

    async renameWorld(id, name) {
      if (this.online) return MCNet.patchWorld(id, { name });
      const w = await DB.getWorld(id);
      if (!w) return;
      w.name = name;
      await DB.putWorld(w);
    },

    async patchWorld(id, patch) {
      if (!this.online) return null;
      return MCNet.patchWorld(id, patch);
    },

    async deleteWorld(id) {
      if (this.online) return MCNet.deleteWorld(id);
      return DB.deleteWorld(id);
    },

    async joinWorld(code) {
      if (!this.online) throw new Error('需要连接服务器');
      return MCNet.joinWorld(code);
    },

    async joinLan(id) {
      if (!this.online) throw new Error('需要连接服务器');
      return MCNet.joinLan(id);
    },

    async kickMember(id, deviceId) {
      if (!this.online) throw new Error('需要连接服务器');
      return MCNet.kick(id, deviceId);
    },

    // ---- lease --------------------------------------------------------------
    _clearLease() {
      if (this.lease?.timer) clearInterval(this.lease.timer);
      this.lease = null;
    },

    _beginLease(worldId, token) {
      this._clearLease();
      const lease = { worldId, token, timer: null, lost: false };
      this.lease = lease;
      lease.timer = setInterval(async () => {
        if (lease.lost || this.lease !== lease) return;
        try {
          await MCNet.heartbeat(worldId, token);
        } catch (e) {
          if (e.code === 'LEASE_LOST' || e.code === 'UNAUTHENTICATED') {
            lease.lost = true;
            this._clearLease();
            if (this.onLeaseLost) this.onLeaseLost(e);
          }
        }
      }, 15000);
    },

    async enterWorld(id, opts = {}) {
      if (!this.online) return DB.getWorld(id);
      if (this.lease) await this.leaveWorld();
      const meta = await MCNet.getWorld(id);
      meta.player = meta.playerState || null;
      return meta;
    },

    async leaveWorld() {
      this._clearLease();
    },

    _requireLease(worldId) {
      if (!this.online) return '';
      if (!this.lease || this.lease.worldId !== worldId) {
        const e = new Error('没有有效的世界租约'); e.code = 'LEASE_LOST'; throw e;
      }
      return this.lease.token;
    },

    // ---- chunks / save ------------------------------------------------------
    async loadChunks(id) {
      if (this.online) {
        const map = new Map();
        let cursor = 0;
        for (;;) {
          const page = await MCNet.getChunks(id, cursor, 128);
          for (const c of page.chunks) {
            map.set(ckey(c.cx, c.cz), { b: MCNet.b64ToU16(c.b), m: MCNet.b64ToU16(c.m) });
          }
          if (page.nextCursor == null) break;
          cursor = page.nextCursor;
        }
        return map;
      }
      return DB.loadChunks(id);
    },

    async saveWorld(meta, chunkList) {
      if (!this.online) {
        await DB.putChunks(meta.id, chunkList);
        await DB.putWorld(meta);
        return { revision: meta.revision || 0, savedChunks: chunkList.length };
      }

      // S1: blocks are authoritative on the server (WebSocket ops); only the
      // per-device player state is saved from the client.
      if (meta.player) await MCNet.putPlayer(meta.id, meta.player);
      return { revision: meta.revision || 0, savedChunks: 0 };
    },

    async importLocalWorlds(onProgress) {
      if (!this.online) throw new Error('需要连接服务器');
      const worlds = await DB.listWorlds();
      let imported = 0;
      for (const local of worlds) {
        if (localStorage.getItem(IMPORT_FLAG + local.id) === '1') continue;
        onProgress && onProgress(`导入 ${local.name}…`);
        const remote = await MCNet.createWorld({
          name: local.name, seed: local.seed, mode: local.mode, flat: !!local.flat,
          time: local.time, weather: local.weather, rainTarget: local.rainTarget,
          spawn: local.spawn, adv: local.adv, stats: local.stats, tutorial: local.tutorial,
          blockEntities: local.blockEntities, mobs: local.mobs, created: local.created,
        });
        const lease = await MCNet.lease(remote.id);
        try {
          if (local.player) await MCNet.putPlayer(remote.id, local.player, lease.token);
          const chunks = await DB.loadChunks(local.id);
          const list = [];
          for (const [key, rec] of chunks) {
            list.push([Math.floor(key / 65536) - 32768, (key % 65536) - 32768, rec]);
          }
          const saveId = MCNet.newSaveId();
          for (let i = 0; i < list.length; i += 64) {
            await MCNet.stageChunks(remote.id, saveId, list.slice(i, i + 64), lease.token);
          }
          const meta = { ...remote, ...local, id: remote.id, revision: 0 };
          delete meta.player;
          await MCNet.commit(remote.id, saveId, 0, meta, lease.token);
        } finally {
          MCNet.releaseLease(remote.id, lease.token).catch(() => { });
        }
        localStorage.setItem(IMPORT_FLAG + local.id, '1');
        imported++;
      }
      return imported;
    },
  };

  window.MCStore = Store;
})();
