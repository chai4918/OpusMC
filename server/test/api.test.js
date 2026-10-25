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

async function req(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
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
  const r = await req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('create world and list it', async () => {
  const r = await req('POST', '/api/worlds', { name: '测试世界', seed: '123', mode: 'survival', flat: false });
  assert.equal(r.status, 201);
  assert.ok(r.body.id.startsWith('w'));
  assert.equal(r.body.revision, 0);
  const list = await req('GET', '/api/worlds');
  assert.equal(list.status, 200);
  assert.equal(list.body.worlds.length, 1);
  assert.equal(list.body.worlds[0].name, '测试世界');
});

test('two-phase save, chunks, revision conflict', async () => {
  const created = await req('POST', '/api/worlds', { name: '存档', seed: '1', mode: 'creative', flat: false });
  const id = created.body.id;
  const saveId = 'savetest12345678';
  const staged = await req('POST', `/api/worlds/${id}/save/stage`, { saveId, chunks: [{ cx: 0, cz: 0, ...CHUNK }] });
  assert.equal(staged.status, 200);
  assert.equal(staged.body.staged, 1);

  const meta = { ...created.body, name: '存档', time: 5000, player: { pos: [0, 64, 0] } };
  const commit = await req('POST', `/api/worlds/${id}/save/commit`, { saveId, baseRevision: 0, meta });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.revision, 1);
  assert.equal(commit.body.savedChunks, 1);

  const chunks = await req('GET', `/api/worlds/${id}/chunks?cursor=0&limit=10`);
  assert.equal(chunks.status, 200);
  assert.equal(chunks.body.chunks.length, 1);
  assert.equal(chunks.body.chunks[0].cx, 0);
  assert.equal(chunks.body.nextCursor, null);
  assert.deepEqual(Buffer.from(chunks.body.chunks[0].b, 'base64'), Buffer.from(CHUNK.b, 'base64'));

  const stale = await req('POST', `/api/worlds/${id}/save/commit`, { saveId: 'anothersave123', baseRevision: 0, meta });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'CONFLICT_REVISION');

  const read = await req('GET', `/api/worlds/${id}`);
  assert.equal(read.body.revision, 1);
  assert.equal(read.body.time, 5000);
});

test('rejects invalid chunk data', async () => {
  const created = await req('POST', '/api/worlds', { name: 'bad', seed: '1', mode: 'survival' });
  const id = created.body.id;
  const bad = await req('POST', `/api/worlds/${id}/save/stage`, {
    saveId: 'badsave123456',
    chunks: [{ cx: 0, cz: 0, b: Buffer.from([1, 2, 3]).toString('base64'), m: CHUNK.m }],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'BAD_CHUNK');
});

test('data survives a server restart', async () => {
  const created = await req('POST', '/api/worlds', { name: '持久化', seed: '42', mode: 'survival' });
  const id = created.body.id;
  const saveId = 'persistsave1234';
  await req('POST', `/api/worlds/${id}/save/stage`, { saveId, chunks: [{ cx: 2, cz: 3, ...CHUNK }] });
  await req('POST', `/api/worlds/${id}/save/commit`, { saveId, baseRevision: 0, meta: { ...created.body, name: '持久化', time: 777 } });

  await app.close();
  app = createApp({ dataDir: tmp });
  const addr = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${addr.port}`;

  const read = await req('GET', `/api/worlds/${id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.time, 777);
  const chunks = await req('GET', `/api/worlds/${id}/chunks?cursor=0&limit=10`);
  assert.equal(chunks.body.chunks.length, 1);
  assert.equal(chunks.body.chunks[0].cz, 3);
});
