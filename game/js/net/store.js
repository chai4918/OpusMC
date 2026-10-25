'use strict';
// ---------------------------------------------------------------------------
// Storage facade: local IndexedDB (offline single player) or the authoritative
// server (HTTP). Classic script: exposed as window.MCStore.
// ---------------------------------------------------------------------------
(function () {
  const IMPORT_FLAG = 'mcjs-imported:';
  const FORCE_LOCAL = 'mcjs-force-local';

  const Store = {
    mode: 'local',
    online: false,
    reason: '',
    backend: 'memory',

    async init() {
      await DB.open();
      this.backend = DB.backend;
      this.online = false;
      this.mode = 'local';
      this.reason = '';
      if (localStorage.getItem(FORCE_LOCAL) === '1') { this.reason = '已强制本机模式'; return; }
      if (location.protocol === 'file:') { this.reason = 'file:// 下无法连接服务器'; return; }
      try {
        const h = await MCNet.health();
        if (h && h.ok) {
          this.online = true;
          this.mode = 'remote';
        }
      } catch (e) {
        this.reason = e.code === 'NETWORK' ? '未连接服务器' : (e.message || '服务器不可用');
      }
    },

    statusText() {
      if (this.online) return '云存档已连接（服务端权威）';
      return '本机存档' + (this.reason ? ' · ' + this.reason : '');
    },

    useLocal() {
      localStorage.setItem(FORCE_LOCAL, '1');
      location.reload();
    },

    useServer() {
      localStorage.removeItem(FORCE_LOCAL);
      location.reload();
    },

    async listWorlds() {
      if (this.online) {
        const r = await MCNet.listWorlds();
        return (r.worlds || []).map(w => ({ ...w, origin: 'remote' }));
      }
      const worlds = await DB.listWorlds();
      return worlds.map(w => ({ ...w, origin: 'local' }));
    },

    async getWorld(id) {
      if (this.online) return MCNet.getWorld(id);
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
        created: now,
        lastPlayed: now,
        time: 1000,
        weather: 0,
        rainTarget: 0,
        spawn: null,
        player: null,
        adv: {},
        stats: { kills: 0, placed: 0, mined: 0 },
        tutorial: meta.mode === 'creative' ? -1 : 0,
        blockEntities: {},
        mobs: [],
        revision: 0,
        origin: 'local',
      };
      await DB.putWorld(world);
      return world;
    },

    async renameWorld(id, name) {
      if (this.online) return MCNet.renameWorld(id, name);
      const w = await DB.getWorld(id);
      if (!w) return;
      w.name = name;
      await DB.putWorld(w);
    },

    async deleteWorld(id) {
      if (this.online) return MCNet.deleteWorld(id);
      return DB.deleteWorld(id);
    },

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

      // Two-phase save: stage all dirty chunks, then commit meta + revision atomically.
      const saveId = MCNet.newSaveId();
      const BATCH = 64;
      for (let i = 0; i < chunkList.length; i += BATCH) {
        await MCNet.stageChunks(meta.id, saveId, chunkList.slice(i, i + BATCH));
      }
      try {
        const res = await MCNet.commit(meta.id, saveId, meta.revision || 0, meta);
        meta.revision = res.revision;
        return res;
      } catch (e) {
        MCNet.abort(meta.id, saveId).catch(() => { });
        throw e;
      }
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
          spawn: local.spawn, player: local.player, adv: local.adv, stats: local.stats,
          tutorial: local.tutorial, blockEntities: local.blockEntities, mobs: local.mobs,
          created: local.created,
        });
        const chunks = await DB.loadChunks(local.id);
        const list = [];
        for (const [key, rec] of chunks) {
          const cx = Math.floor(key / 65536) - 32768;
          const cz = (key % 65536) - 32768;
          list.push([cx, cz, rec]);
        }
        const saveId = MCNet.newSaveId();
        for (let i = 0; i < list.length; i += 64) {
          await MCNet.stageChunks(remote.id, saveId, list.slice(i, i + 64));
        }
        const meta = { ...remote, ...local, id: remote.id, revision: 0 };
        await MCNet.commit(remote.id, saveId, 0, meta);
        localStorage.setItem(IMPORT_FLAG + local.id, '1');
        imported++;
      }
      return imported;
    },
  };

  window.MCStore = Store;
})();
