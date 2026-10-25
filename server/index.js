import { config } from './config.js';
import { createApp, lanAddresses } from './app.js';

const app = createApp();

let backupTimer = null;
let closing = false;

async function main() {
  try {
    const addr = await app.listen(config.port, config.host);
    const port = addr.port;
    console.log('');
    console.log('  OpusMC 云存档服务器已启动');
    console.log('  ------------------------------------------');
    console.log(`  本机:   http://localhost:${port}/`);
    for (const ip of lanAddresses()) console.log(`  局域网: http://${ip}:${port}/`);
    console.log(`  数据:   ${config.dataDir}`);
    console.log('  ------------------------------------------');
    console.log('  按 Ctrl+C 停止（会先保存备份）');
    console.log('');

    backupTimer = setInterval(() => {
      try {
        const file = app.store.backup();
        console.log('[backup]', file);
      } catch (e) {
        console.error('[backup] failed:', e.message);
      }
    }, config.backupIntervalMs);
    backupTimer.unref?.();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${config.port} 已被占用。可用 MC_PORT=8789 指定其它端口。`);
    } else {
      console.error('启动失败:', e);
    }
    process.exit(1);
  }
}

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[${signal}] 正在关闭…`);
  if (backupTimer) clearInterval(backupTimer);
  try { app.store.backup(); } catch (e) { console.error('[backup] failed:', e.message); }
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main();
