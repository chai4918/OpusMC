'use strict';
// ---------------------------------------------------------------------------
// S1 co-op: WebSocket presence, shared block edits, chat and server time.
// Loaded as a classic script; exposed as window.MCRealtime.
// ---------------------------------------------------------------------------
(function () {
  class RemotePlayer {
    constructor(game, id, name) {
      this.game = game; this.id = id; this.name = name;
      this.pos = [0, 64, 0]; this.prev = [0, 64, 0];
      this.yaw = 0; this.prevYaw = 0; this.pitch = 0;
      this.type = 'player'; this.T = { model: 'steve', scale: 0.9375 };
      this.isRemotePlayer = true;
      this.deathTime = 0; this.fire = 0; this.hurtTime = 0; this.baby = false;
      this.inv = { held: null };
      this.limbSwing = 0; this.limbAmt = 0;
      this.lastUpdate = 0; this.swingUntil = 0;
    }
    ipos(a) {
      return [lerp(this.prev[0], this.pos[0], a), lerp(this.prev[1], this.pos[1], a), lerp(this.prev[2], this.pos[2], a)];
    }
    lightAt() {
      const w = this.game.world;
      if (!w) return [1, 0];
      const x = Math.floor(this.pos[0]), y = Math.floor(this.pos[1] + 1.2), z = Math.floor(this.pos[2]);
      const l = w.getLight(x, y, z);
      return [(l >> 4) / 15, (l & 15) / 15];
    }
    pose() {
      const now = performance.now();
      if (now - this.lastUpdate > 260) this.limbAmt *= 0.88;
      const swing = this.limbSwing * 0.6662, amt = this.limbAmt;
      const l = Math.cos(swing) * 1.4 * amt, r = -l;
      const sw = now < this.swingUntil ? Math.sin((this.swingUntil - now) / 300 * Math.PI) : 0;
      return { head: { rx: this.pitch }, rarm: { rx: r * 0.7 - sw * 1.2 }, larm: { rx: l * 0.7 }, rleg: { rx: l }, lleg: { rx: r } };
    }
  }

  const R = {
    active: false,
    ws: null,
    worldId: null,
    game: null,
    selfId: null,
    remotes: new Map(),
    leaving: false,
    reconnectTimer: null,
    pending: null,
    lastPlayerSent: 0,

    join(worldId, game) {
      if (this.active && this.worldId === worldId && this.ws && this.ws.readyState <= 1) return;
      this.leave();
      this.worldId = worldId; this.game = game; this.leaving = false;
      this.connect();
    },

    connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;
      try { ws = new WebSocket(`${proto}//${location.host}/ws`); } catch { return; }
      this.ws = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'join', worldId: this.worldId }));
      };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        this.handle(m);
      };
      ws.onclose = () => {
        this.active = false;
        this.remotes.clear();
        if (!this.leaving && this.game && this.game.state === 'play') {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.connect(), 3000);
        }
      };
      ws.onerror = () => { };
    },

    handle(m) {
      const g = this.game;
      if (!g) return;
      switch (m.t) {
        case 'welcome':
          this.active = true; this.selfId = m.self || m.player?.id;
          g.worldTime = m.time;
          g.weather = m.weather || 0;
          this.remotes.clear();
          for (const p of m.players || []) this.upsert(p);
          g.ui.message(`已加入多人世界（${(m.players || []).length + 1} 人）`, '#55FF55');
          if (g.player) {
            this.lastPlayerSent = 0;
            this.sendPlayer(g.player.pos, g.player.yaw, g.player.pitch, 0);
          }
          break;
        case 'join':
          this.upsert(m.player);
          g.ui.message(`${m.player.name} 加入了世界`, '#55FF55');
          break;
        case 'leave': {
          const rp = this.remotes.get(m.id);
          if (rp) { g.ui.message(`${rp.name} 离开了世界`, '#AAAAAA'); this.remotes.delete(m.id); }
          break;
        }
        case 'player': this.upsert(m.player); break;
        case 'block': {
          if (!g.world) break;
          const wx = m.cx * 16 + m.x, wz = m.cz * 16 + m.z;
          g.world.setBlock(wx, m.y, wz, m.id, m.meta);
          g.flushMesh();
          break;
        }
        case 'time':
          g.worldTime = m.time;
          g.weather = m.weather || 0;
          break;
        case 'chat':
          g.ui.message(`${m.name}: ${m.text}`, '#FFFFFF');
          break;
        case 'be': {
          const key = `${m.x},${m.y},${m.z}`;
          const be = { type: m.type, pos: [m.x, m.y, m.z], ...(m.data || {}) };
          g.blockEntities.set(key, be);
          const sc = g.ui.screen;
          if (sc && sc.be && sc.be.pos && sc.be.pos[0] === m.x && sc.be.pos[1] === m.y && sc.be.pos[2] === m.z) {
            if (m.type === 'chest') sc.be.slots = (m.data && m.data.slots) || new Array(27).fill(null);
            else Object.assign(sc.be, m.data || {});
          }
          break;
        }
        case 'be_remove': {
          const key = `${m.x},${m.y},${m.z}`;
          g.blockEntities.delete(key);
          const sc = g.ui.screen;
          if (sc && sc.be && sc.be.pos && sc.be.pos[0] === m.x && sc.be.pos[1] === m.y && sc.be.pos[2] === m.z) g.ui.close();
          break;
        }
        case 'needChunk': {
          const ch = g.world && g.world.getChunk(m.cx, m.cz);
          if (!ch) break;
          const rec = encodeChunk(ch);
          this.send({ t: 'chunk', cx: m.cx, cz: m.cz, b: MCNet.u16ToB64(rec.b), m: MCNet.u16ToB64(rec.m) });
          this.pending = m.op || null;
          setTimeout(() => {
            if (this.pending) { this.sendBlock(this.pending.x, this.pending.y, this.pending.z, this.pending.id, this.pending.meta); this.pending = null; }
          }, 150);
          break;
        }
        case 'chunk_ok':
          break;
      }
    },

    upsert(p) {
      if (!p || p.id === this.selfId) return;
      let rp = this.remotes.get(p.id);
      if (!rp) {
        rp = new RemotePlayer(this.game, p.id, p.name);
        rp.pos = [p.x, p.y, p.z]; rp.prev = [p.x, p.y, p.z];
        rp.yaw = p.yaw; rp.prevYaw = p.yaw; rp.pitch = p.pitch;
        rp.lastUpdate = performance.now();
        this.remotes.set(p.id, rp);
        return;
      }
      const now = performance.now();
      const dt = Math.max(0.05, (now - (rp.lastUpdate || now)) / 1000);
      const dist = Math.hypot(p.x - rp.pos[0], p.y - rp.pos[1], p.z - rp.pos[2]);
      const speed = dist / dt;
      rp.limbAmt = lerp(rp.limbAmt, speed > 0.6 ? 1 : 0, 0.35);
      rp.limbSwing += dist * 1.6;
      if (p.flags & 4) rp.swingUntil = now + 300;
      rp.prev = rp.pos.slice();
      rp.pos = [p.x, p.y, p.z];
      rp.prevYaw = rp.yaw;
      rp.yaw = p.yaw;
      rp.pitch = p.pitch;
      rp.lastUpdate = now;
    },

    send(obj) {
      if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify(obj)); } catch { /* ignore */ } }
    },

    sendPlayer(pos, yaw, pitch, flags = 0) {
      if (!this.active) return;
      const now = performance.now();
      if (now - this.lastPlayerSent < 90) return;
      this.lastPlayerSent = now;
      this.send({ t: 'player', x: pos[0], y: pos[1], z: pos[2], yaw, pitch, flags });
    },

    sendBlock(x, y, z, id, meta) {
      if (!this.active) return;
      this.send({ t: 'block', cx: x >> 4, cz: z >> 4, x: x & 15, y, z: z & 15, id, meta });
    },

    // used for metadata-only changes (doors, trapdoors, note blocks)
    sendBlockMeta(x, y, z, id, meta) { this.sendBlock(x, y, z, id, meta); },

    sendChat(text) {
      if (!this.active) return;
      this.send({ t: 'chat', text });
    },

    sendBlockEntity(x, y, z, type, be) {
      if (!this.active) return;
      const data = type === 'chest'
        ? { slots: be.slots }
        : { input: be.input, fuel: be.fuel, output: be.output, burn: be.burn, burnMax: be.burnMax, cook: be.cook, xp: be.xp };
      this.send({ t: 'be', x, y, z, type, data });
    },

    leave() {
      this.leaving = true;
      this.active = false;
      clearTimeout(this.reconnectTimer);
      if (this.ws) { try { this.ws.close(); } catch { } }
      this.ws = null;
      this.remotes.clear();
      this.pending = null;
    },
  };

  window.MCRealtime = R;
})();
