import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcjs-store-'));
let app;
let base;

function u16b64(values) {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeUInt16LE(v, i * 2));
  return b.toString('base64');
}

const CHUNK = { b: u16b64([1, 65535, 2, 1]), m: u16b64([0, 65535, 0, 1]) };

async function raw(method, p, body, cookie) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + p, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie') || '';
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: setCookie.split(';')[0] };
}

async function device(key, name) {
  const r = await raw('POST', '/api/device', { clientKey: key, name });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { cookie: r.cookie, ...r.body };
}

test.before(async () => {
  app = createApp({ dataDir: tmp });
  const addr = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(async () => {
  if (app) await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('health', async () => {
  const r = await raw('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.version, 3);
});

test('device bootstrap: stable identity, first device is admin', async () => {
  const a = await device('client-key-aaaaaaaaaaaaaaaa', 'Alice');
  const b = await device('client-key-bbbbbbbbbbbbbbbb', 'Bob');
  assert.equal(a.device.role, 'admin');
  assert.equal(b.device.role, 'player');
  assert.equal(a.isNew, true);

  const again = await device('client-key-aaaaaaaaaaaaaaaa');
  assert.equal(again.device.id, a.device.id);
  assert.equal(again.isNew, false);

  const me = await raw('GET', '/api/me', undefined, again.cookie);
  assert.equal(me.status, 200);
  assert.equal(me.body.device.name, 'Alice');

  const unnamed = await raw('GET', '/api/worlds');
  assert.equal(unnamed.status, 401);
});

test('world ownership, join code, private visibility', async () => {
  const a = await device('client-key-cccccccccccccccc', 'Owner');
  const b = await device('client-key-dddddddddddddddd', 'Guest');
  const created = await raw('POST', '/api/worlds', { name: '基地', seed: '7', mode: 'survival' }, a.cookie);
  assert.equal(created.status, 201);
  const world = created.body;
  assert.match(world.joinCode, /^[A-Z0-9]{6}$/);

  const listA = await raw('GET', '/api/worlds', undefined, a.cookie);
  assert.equal(listA.body.worlds.length, 1);
  assert.equal(listA.body.worlds[0].role, 'owner');
  assert.equal(listA.body.worlds[0].joinCode, world.joinCode);

  const listB = await raw('GET', '/api/worlds', undefined, b.cookie);
  assert.equal(listB.body.worlds.length, 0);
  const denied = await raw('GET', `/api/worlds/${world.id}`, undefined, b.cookie);
  assert.equal(denied.status, 403);

  const joined = await raw('POST', '/api/worlds/join', { code: world.joinCode }, b.cookie);
  assert.equal(joined.status, 200);
  assert.equal(joined.body.role, 'member');
  assert.equal(joined.body.joinCode, undefined);

  const readB = await raw('GET', `/api/worlds/${world.id}`, undefined, b.cookie);
  assert.equal(readB.status, 200);
  assert.equal(readB.body.role, 'member');

  const renameByB = await raw('PATCH', `/api/worlds/${world.id}`, { name: 'hack' }, b.cookie);
  assert.equal(renameByB.status, 403);
});

test('S0 lease: held, takeover, lost', async () => {
  const a = await device('client-key-eeeeeeeeeeeeeeee', 'LeaseA');
  const b = await device('client-key-ffffffffffffffff', 'LeaseB');
  const created = await raw('POST', '/api/worlds', { name: 'Lease', seed: '1', mode: 'creative' }, a.cookie);
  const id = created.body.id;
  await raw('POST', '/api/worlds/join', { code: created.body.joinCode }, b.cookie);

  const la = await raw('POST', `/api/worlds/${id}/lease`, {}, a.cookie);
  assert.equal(la.status, 200);
  assert.ok(la.body.token);

  const held = await raw('POST', `/api/worlds/${id}/lease`, {}, b.cookie);
  assert.equal(held.status, 409);
  assert.equal(held.body.error.code, 'LEASE_HELD');
  assert.equal(held.body.error.holderName, 'LeaseA');

  const taken = await raw('POST', `/api/worlds/${id}/lease`, { takeover: true }, b.cookie);
  assert.equal(taken.status, 200);

  const hb = await raw('POST', `/api/worlds/${id}/lease/heartbeat`, { token: la.body.token }, a.cookie);
  assert.equal(hb.status, 409);
  assert.equal(hb.body.error.code, 'LEASE_LOST');

  const stage = await raw('POST', `/api/worlds/${id}/save/stage`, {
    saveId: 'oldsave12345', leaseToken: la.body.token, chunks: [{ cx: 0, cz: 0, ...CHUNK }],
  }, a.cookie);
  assert.equal(stage.status, 409);

  const ok = await raw('POST', `/api/worlds/${id}/save/stage`, {
    saveId: 'newsave12345', leaseToken: taken.body.token, chunks: [{ cx: 0, cz: 0, ...CHUNK }],
  }, b.cookie);
  assert.equal(ok.status, 200);
});

test('two-phase save, per-device player state and revision conflict', async () => {
  const a = await device('client-key-gggggggggggggggg', 'P1');
  const b = await device('client-key-hhhhhhhhhhhhhhhh', 'P2');
  const created = await raw('POST', '/api/worlds', { name: '存档', seed: '1', mode: 'creative' }, a.cookie);
  const id = created.body.id;
  await raw('POST', '/api/worlds/join', { code: created.body.joinCode }, b.cookie);

  const la = await raw('POST', `/api/worlds/${id}/lease`, {}, a.cookie);
  const saveId = 'saveabcdef123456';
  await raw('POST', `/api/worlds/${id}/save/stage`, { saveId, leaseToken: la.body.token, chunks: [{ cx: 0, cz: 0, ...CHUNK }] }, a.cookie);
  const meta = { ...created.body, name: '存档', time: 5000 };
  const commit = await raw('POST', `/api/worlds/${id}/save/commit`, { saveId, baseRevision: 0, meta, leaseToken: la.body.token }, a.cookie);
  assert.equal(commit.status, 200);
  assert.equal(commit.body.revision, 1);

  const pa = { pos: [1, 2, 3], inv: [], sel: 0 };
  const pb = { pos: [9, 8, 7], inv: [], sel: 1 };
  const putA = await raw('PUT', `/api/worlds/${id}/player`, { data: pa, leaseToken: la.body.token }, a.cookie);
  assert.equal(putA.status, 200);

  // B takes over, then saves its own player state
  const lb = await raw('POST', `/api/worlds/${id}/lease`, { takeover: true }, b.cookie);
  assert.equal(lb.status, 200);
  const putB = await raw('PUT', `/api/worlds/${id}/player`, { data: pb, leaseToken: lb.body.token }, b.cookie);
  assert.equal(putB.status, 200);

  const readA = await raw('GET', `/api/worlds/${id}`, undefined, a.cookie);
  const readB = await raw('GET', `/api/worlds/${id}`, undefined, b.cookie);
  assert.deepEqual(readA.body.playerState, pa);
  assert.deepEqual(readB.body.playerState, pb);

  // stale base revision is rejected even with a valid lease
  const stale = await raw('POST', `/api/worlds/${id}/save/commit`, { saveId: 'stalecode12345', baseRevision: 0, meta, leaseToken: lb.body.token }, b.cookie);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'CONFLICT_REVISION');
});

test('rejects invalid chunk data and unauthenticated staging', async () => {
  const a = await device('client-key-iiiiiiiiiiiiiiii', 'Bad');
  const created = await raw('POST', '/api/worlds', { name: 'bad', seed: '1', mode: 'survival' }, a.cookie);
  const id = created.body.id;
  const la = await raw('POST', `/api/worlds/${id}/lease`, {}, a.cookie);
  const bad = await raw('POST', `/api/worlds/${id}/save/stage`, {
    saveId: 'badsave123456', leaseToken: la.body.token,
    chunks: [{ cx: 0, cz: 0, b: Buffer.from([1, 2, 3]).toString('base64'), m: CHUNK.m }],
  }, a.cookie);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'BAD_CHUNK');

  const noAuth = await raw('POST', `/api/worlds/${id}/save/stage`, { saveId: 'nope12345', chunks: [] });
  assert.equal(noAuth.status, 401);
});

test('owner can kick a member and revoke its lease', async () => {
  const a = await device('client-key-kkkkkkkkkkkkkkkk', 'KickOwner');
  const b = await device('client-key-llllllllllllllll', 'KickGuest');
  const created = await raw('POST', '/api/worlds', { name: 'Kick', seed: '1', mode: 'survival' }, a.cookie);
  const id = created.body.id;
  await raw('POST', '/api/worlds/join', { code: created.body.joinCode }, b.cookie);
  const lb = await raw('POST', `/api/worlds/${id}/lease`, {}, b.cookie);
  assert.equal(lb.status, 200);

  const kicked = await raw('POST', `/api/worlds/${id}/kick`, { deviceId: b.device.id }, a.cookie);
  assert.equal(kicked.status, 200);
  assert.equal(kicked.body.members.some(m => m.device_id === b.device.id), false);

  const read = await raw('GET', `/api/worlds/${id}`, undefined, b.cookie);
  assert.equal(read.status, 403);
  const hb = await raw('POST', `/api/worlds/${id}/lease/heartbeat`, { token: lb.body.token }, b.cookie);
  assert.equal(hb.status, 409);
  assert.equal(hb.body.error.code, 'LEASE_LOST');
});

test('data survives a server restart', async () => {
  const a = await device('client-key-jjjjjjjjjjjjjjjj', 'Persist');
  const created = await raw('POST', '/api/worlds', { name: '持久化', seed: '42', mode: 'survival' }, a.cookie);
  const id = created.body.id;
  const la = await raw('POST', `/api/worlds/${id}/lease`, {}, a.cookie);
  const saveId = 'persistsave1234';
  await raw('POST', `/api/worlds/${id}/save/stage`, { saveId, leaseToken: la.body.token, chunks: [{ cx: 2, cz: 3, ...CHUNK }] }, a.cookie);
  await raw('POST', `/api/worlds/${id}/save/commit`, { saveId, baseRevision: 0, meta: { ...created.body, time: 777 }, leaseToken: la.body.token }, a.cookie);

  await app.close();
  app = createApp({ dataDir: tmp });
  const addr = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${addr.port}`;

  const me = await raw('GET', '/api/me', undefined, a.cookie);
  assert.equal(me.status, 200); // token stays valid until the next device bootstrap
  const again = await device('client-key-jjjjjjjjjjjjjjjj');
  assert.equal(again.device.name, 'Persist');

  const read = await raw('GET', `/api/worlds/${id}`, undefined, again.cookie);
  assert.equal(read.status, 200);
  assert.equal(read.body.time, 777);
  const chunks = await raw('GET', `/api/worlds/${id}/chunks?cursor=0&limit=10`, undefined, again.cookie);
  assert.equal(chunks.body.chunks.length, 1);
  assert.equal(chunks.body.chunks[0].cz, 3);
});
