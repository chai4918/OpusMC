import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

export function attachWebSocket(server, { authenticate, store, onConnection }) {
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { return destroy(socket, 400); }
    if (url.pathname !== '/ws') return destroy(socket, 404);
    const device = authenticate(req, store);
    if (!device) return destroy(socket, 401);
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') return destroy(socket, 400);
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const conn = new Connection(socket);
    if (head && head.length) conn.feed(head);
    onConnection(conn, device);
  });
}

function destroy(socket, status) {
  try {
    socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Request'}\r\nConnection: close\r\n\r\n`);
  } catch { /* ignore */ }
  socket.destroy();
}

class Connection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.handlers = { message: [], close: [] };
    this.lastPong = Date.now();
    socket.on('data', (d) => this.feed(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastPong > 90000) return this.close(1001, 'timeout');
      this._frame(0x9, Buffer.alloc(0));
    }, 30000);
    this.pingTimer.unref?.();
  }

  on(event, fn) { this.handlers[event]?.push(fn); }
  _emit(event, arg) { for (const fn of this.handlers[event] || []) fn(arg); }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'too large');
        len = Number(big); off = 10;
      }
      if (len > MAX_MESSAGE) return this.close(1009, 'too large');
      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < off + maskLen + len) return;
      const mask = masked ? this.buffer.subarray(off, off + 4) : null;
      off += maskLen;
      const payload = Buffer.from(this.buffer.subarray(off, off + len));
      this.buffer = this.buffer.subarray(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      if (opcode === 0x8) { this.close(1000); continue; }
      if (opcode === 0x9) { this._frame(0xA, payload); continue; }
      if (opcode === 0xA) { this.lastPong = Date.now(); continue; }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) { this.fragments = [payload]; this.fragmentOpcode = opcode; continue; }
        this._deliver(opcode, payload);
        continue;
      }
      if (opcode === 0x0) {
        this.fragments.push(payload);
        if (Buffer.concat(this.fragments).length > MAX_MESSAGE) return this.close(1009, 'too large');
        if (fin) {
          const data = Buffer.concat(this.fragments);
          const op = this.fragmentOpcode;
          this.fragments = [];
          this._deliver(op, data);
        }
      }
    }
  }

  _deliver(opcode, payload) {
    if (opcode !== 0x1) return;
    const text = payload.toString('utf8');
    this._emit('message', text);
  }

  send(obj) {
    if (this.closed) return false;
    if (this.socket.writableLength > 2 * 1024 * 1024) return false;
    this._frame(0x1, Buffer.from(JSON.stringify(obj)));
    return true;
  }

  _frame(opcode, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { this._closed(); }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(reason);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this._frame(0x8, p);
    this.closed = true;
    clearInterval(this.pingTimer);
    try { this.socket.end(); } catch { /* ignore */ }
    this._closed();
  }

  _closed() {
    if (this._didClose) return;
    this._didClose = true;
    this.closed = true;
    clearInterval(this.pingTimer);
    this._emit('close');
  }
}
