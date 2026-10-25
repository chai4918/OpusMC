import { parseClientChunk, packChunk } from './chunk-codec.js';

const TICK_MS = 50;
const SNAPSHOT_TICKS = 20; // broadcast time once per second
const SAVE_TICKS = 200;    // persist clock every 10s

export function createRealtime(store) {
  const rooms = new Map();

  function onConnection(conn, device) {
    let room = null;
    let player = null;
    let joined = false;
    const limits = { block: 0, chat: 0, player: 0, last: 0 };
    const joinTimer = setTimeout(() => { if (!joined) conn.close(1008, 'join timeout'); }, 10000);
    joinTimer.unref?.();

    conn.on('message', (text) => {
      let m;
      try { m = JSON.parse(text); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      if (!joined) {
        if (m.t !== 'join') return;
        const world = store.getWorld(String(m.worldId || ''));
        if (!world || !store.isMember(world.id, device.id)) { conn.close(1008, 'not a member'); return; }
        let r = rooms.get(world.id);
        if (!r) { r = new Room(world.id, store); rooms.set(world.id, r); }
        room = r;
        player = room.join(conn, device);
        joined = true;
        clearTimeout(joinTimer);
        return;
      }
      if (m.t === 'player') {
        if (!allow(limits, 'player', 40)) return;
        room.updatePlayer(player, m);
      } else if (m.t === 'block') {
        if (!allow(limits, 'block', 30)) return;
        room.block(player, m);
      } else if (m.t === 'chunk') {
        if (!allow(limits, 'block', 30)) return;
        room.chunk(player, m);
      } else if (m.t === 'be') {
        if (!allow(limits, 'block', 30)) return;
        room.be(player, m);
      } else if (m.t === 'chat') {
        if (!allow(limits, 'chat', 3)) return;
        room.chat(player, m);
      }
    });

    conn.on('close', () => {
      clearTimeout(joinTimer);
      if (room && player) room.leave(player);
    });
  }

  return { onConnection, rooms };
}

function allow(limits, key, perSecond) {
  const now = Date.now();
  if (now - limits.last > 1000) { limits.last = now; limits.player = limits.block = limits.chat = 0; }
  limits[key] = (limits[key] || 0) + 1;
  return limits[key] <= perSecond;
}

class Room {
  constructor(worldId, store) {
    this.id = worldId;
    this.store = store;
    this.clients = new Map(); // deviceId -> entry
    this.world = store.getWorld(worldId) || {};
    this.time = this.world.time || 1000;
    this.weather = this.world.weather || 0;
    this.rainTarget = this.world.rainTarget || 0;
    this.ticks = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  join(conn, device) {
    const existing = this.clients.get(device.id);
    if (existing) { existing.conn.close(1008, 'replaced'); this.clients.delete(device.id); }
    const ps = this.store.getPlayerState(this.id, device.id);
    const p0 = Array.isArray(ps?.pos) ? ps.pos : [0, 64, 0];
    const entry = {
      conn, deviceId: device.id, name: device.name,
      x: Number(p0[0]) || 0, y: Number(p0[1]) || 64, z: Number(p0[2]) || 0, yaw: 0, pitch: 0, flags: 0, joinedAt: Date.now(),
    };
    this.clients.set(device.id, entry);
    conn.send({
      t: 'welcome', worldId: this.id, time: this.time, weather: this.weather,
      self: device.id,
      players: [...this.clients.values()].filter(e => e !== entry).map(publicPlayer),
    });
    this.broadcast({ t: 'join', player: publicPlayer(entry) }, entry.deviceId);
    return entry;
  }

  leave(entry) {
    if (!this.clients.has(entry.deviceId)) return;
    this.clients.delete(entry.deviceId);
    this.broadcast({ t: 'leave', id: entry.deviceId });
    if (this.clients.size === 0) this.destroy();
  }

  updatePlayer(entry, m) {
    const x = Number(m.x), y = Number(m.y), z = Number(m.z), yaw = Number(m.yaw), pitch = Number(m.pitch);
    if (![x, y, z, yaw, pitch].every(Number.isFinite)) return;
    if (Math.abs(x) > 3e7 || Math.abs(z) > 3e7 || y < -64 || y > 512) return;
    entry.x = x; entry.y = y; entry.z = z; entry.yaw = yaw; entry.pitch = pitch; entry.flags = Number(m.flags) | 0;
    this.broadcast({ t: 'player', player: publicPlayer(entry) }, entry.deviceId);
  }

  block(entry, m) {
    const cx = Number(m.cx), cz = Number(m.cz), x = Number(m.x), y = Number(m.y), z = Number(m.z);
    const id = Number(m.id), meta = Number(m.meta) | 0;
    if (![cx, cz, x, y, z, id].every(Number.isFinite)) return;
    if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y > 255 || id < 0 || id > 255) return;
    const dx = (cx * 16 + x + 0.5) - entry.x, dy = (y + 0.5) - entry.y, dz = (cz * 16 + z + 0.5) - entry.z;
    if (dx * dx + dy * dy + dz * dz > 100) return; // 10 blocks max
    const res = this.store.applyBlock(this.id, cx, cz, x, y, z, id, meta);
    if (!res.ok) {
      if (res.missing) entry.conn.send({ t: 'needChunk', cx, cz, op: { cx, cz, x, y, z, id, meta } });
      return;
    }
    this.broadcast({ t: 'block', from: entry.deviceId, cx, cz, x, y, z, id, meta }, entry.deviceId);
    const wx = cx * 16 + x, wz = cz * 16 + z;
    if (res.previous !== id) {
      this.store.deleteBlockEntity(this.id, wx, y, wz);
      this.broadcast({ t: 'be_remove', x: wx, y, z: wz });
    }
  }

  be(entry, m) {
    const x = Number(m.x), y = Number(m.y), z = Number(m.z);
    if (![x, y, z].every(Number.isInteger)) return;
    if (m.type !== 'chest' && m.type !== 'furnace') return;
    if (!m.data || typeof m.data !== 'object') return;
    if (JSON.stringify(m.data).length > 64 * 1024) return;
    const dx = (x + 0.5) - entry.x, dy = (y + 0.5) - entry.y, dz = (z + 0.5) - entry.z;
    if (dx * dx + dy * dy + dz * dz > 100) return;
    this.store.putBlockEntity(this.id, x, y, z, m.type, m.data);
    this.broadcast({ t: 'be', x, y, z, type: m.type, data: m.data }, entry.deviceId);
  }

  chunk(entry, m) {
    const cx = Number(m.cx), cz = Number(m.cz);
    if (!Number.isInteger(cx) || !Number.isInteger(cz)) return;
    let blob;
    try { blob = packChunk(parseClientChunk({ b: m.b, m: m.m })); } catch { return; }
    this.store.putChunkData(this.id, cx, cz, blob);
    entry.conn.send({ t: 'chunk_ok', cx, cz });
  }

  chat(entry, m) {
    const text = String(m.text || '').replace(/[\u0000-\u001f]/g, '').slice(0, 200);
    if (!text.trim()) return;
    this.broadcast({ t: 'chat', id: entry.deviceId, name: entry.name, text });
  }

  tick() {
    this.ticks++;
    this.time++;
    if (this.ticks % SNAPSHOT_TICKS === 0) {
      this.broadcast({ t: 'time', time: this.time, weather: this.weather });
    }
    if (this.ticks % SAVE_TICKS === 0) {
      try { this.store.updateWorldClock(this.id, this.time, this.weather, this.rainTarget); } catch { /* ignore */ }
    }
  }

  broadcast(msg, exclude) {
    for (const e of this.clients.values()) {
      if (exclude && e.deviceId === exclude) continue;
      e.conn.send(msg);
    }
  }

  destroy() {
    clearInterval(this.timer);
    try { this.store.updateWorldClock(this.id, this.time, this.weather, this.rainTarget); } catch { /* ignore */ }
  }
}

function publicPlayer(e) {
  return { id: e.deviceId, name: e.name, x: e.x, y: e.y, z: e.z, yaw: e.yaw, pitch: e.pitch, flags: e.flags };
}
