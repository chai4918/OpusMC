import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcjs-ws-'));
let app;
let base;
let port;

function u16b64(values) {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeUInt16LE(v, i * 2));
  return b.toString('base64');
}
const CHUNK = { b: u16b64([1, 65535, 2, 1]), m: u16b64([0, 65535, 0, 1]) };

async function call(method, p, body, cookie) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const sc = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie') || '';
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: sc.split(';')[0] };
}

async function device(key, name) {
  const r = await call('POST', '/api/device', { clientKey: key, name });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.cookie;
}

function wsConnect(cookie) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let fragments = [];
    const messages = [];
    const waiters = [];

    const api = {
      messages,
      send(obj) {
        const payload = Buffer.from(JSON.stringify(obj));
        const mask = crypto.randomBytes(4);
        let header;
        if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
        else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
        else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
        sock.write(Buffer.concat([header, mask, masked]));
      },
      waitFor(type, timeoutMs = 3000) {
        const found = messages.find(m => m.t === type);
        if (found) return Promise.resolve(found);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timeout waiting for ' + type + '; got ' + messages.map(m => m.t).join(','))), timeoutMs);
          waiters.push({ type, res: (m) => { clearTimeout(timer); res(m); } });
        });
      },
      close() { try { sock.destroy(); } catch { /* ignore */ } },
    };

    sock.on('connect', () => {
      sock.write(
        'GET /ws HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        `Cookie: ${cookie}\r\n\r\n`,
      );
    });
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString();
        if (!head.startsWith('HTTP/1.1 101')) return reject(new Error('upgrade failed: ' + head.split('\r\n')[0]));
        buf = buf.subarray(idx + 4);
        upgraded = true;
        resolve(api);
      }
      while (upgraded && buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 0x1 || opcode === 0x0) {
          fragments.push(payload);
          if (!fin) continue;
          const text = Buffer.concat(fragments).toString('utf8');
          fragments = [];
          let m; try { m = JSON.parse(text); } catch { continue; }
          messages.push(m);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].type === m.t) { const w = waiters.splice(i, 1)[0]; w.res(m); }
          }
        } else if (opcode === 0x8) { sock.destroy(); }
      }
    });
  });
}

test.before(async () => {
  app = createApp({ dataDir: tmp });
  const addr = await app.listen(0, '127.0.0.1');
  port = addr.port;
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (app) await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('S1: presence, block sync, chat and server time', async () => {
  const aCookie = await device('ws-test-device-aaaaaaaaaaaa', 'WS-A');
  const bCookie = await device('ws-test-device-bbbbbbbbbbbb', 'WS-B');
  const created = await call('POST', '/api/worlds', { name: 'WS', seed: '1', mode: 'creative' }, aCookie);
  const worldId = created.body.id;
  await call('POST', '/api/worlds/join', { code: created.body.joinCode }, bCookie);

  const a = await wsConnect(aCookie);
  const b = await wsConnect(bCookie);

  a.send({ t: 'join', worldId });
  const wa = await a.waitFor('welcome');
  assert.equal(wa.worldId, worldId);

  b.send({ t: 'join', worldId });
  const wb = await b.waitFor('welcome');
  assert.equal(wb.players.length, 1, 'B should see A');
  await a.waitFor('join');

  a.send({ t: 'player', x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, flags: 0 });
  const seen = await b.waitFor('player');
  assert.equal(seen.player.x, 0.5);

  a.send({ t: 'chunk', cx: 0, cz: 0, ...CHUNK });
  await new Promise(r => setTimeout(r, 100));
  a.send({ t: 'block', cx: 0, cz: 0, x: 0, y: 64, z: 0, id: 3, meta: 0 });
  const block = await b.waitFor('block');
  assert.equal(block.id, 3);
  assert.equal(block.cx, 0);

  a.send({ t: 'be', x: 0, y: 64, z: 0, type: 'chest', data: { slots: [{ id: 1, count: 2 }, null] } });
  const be = await b.waitFor('be');
  assert.equal(be.type, 'chest');
  assert.equal(be.data.slots[0].count, 2);
  const beList = await call('GET', `/api/worlds/${worldId}/block-entities`, undefined, bCookie);
  assert.equal(beList.body.entities['0,64,0'].slots[0].count, 2);

  a.send({ t: 'block', cx: 0, cz: 0, x: 0, y: 64, z: 0, id: 0, meta: 0 });
  await b.waitFor('be_remove');
  const beGone = await call('GET', `/api/worlds/${worldId}/block-entities`, undefined, bCookie);
  assert.equal(beGone.body.entities['0,64,0'], undefined);

  a.send({ t: 'chat', text: 'hello from A' });
  const chat = await b.waitFor('chat');
  assert.equal(chat.name, 'WS-A');
  assert.equal(chat.text, 'hello from A');

  const time = await b.waitFor('time', 2500);
  assert.ok(Number.isFinite(time.time));

  a.close(); b.close();
});
