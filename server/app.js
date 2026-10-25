import http from 'node:http';
import os from 'node:os';
import { config } from './config.js';
import { openDb } from './db.js';
import { createApi } from './api.js';
import { createStaticHandler } from './static.js';
import { attachWebSocket } from './ws.js';
import { createRealtime } from './rooms.js';
import { authenticate } from './auth.js';

export function createApp({ dataDir = config.dataDir, gameDir = config.gameDir } = {}) {
  const store = openDb(dataDir);
  const api = createApi(store);
  const serveStatic = createStaticHandler(gameDir);
  const realtime = createRealtime(store);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  });
  attachWebSocket(server, { authenticate, store, onConnection: realtime.onConnection });

  return {
    server,
    store,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
      store.close();
    },
  };
}

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}
