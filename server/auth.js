import crypto from 'node:crypto';

export const COOKIE_NAME = 'mcjs_device';
const SESSION_MAX_AGE = 365 * 24 * 60 * 60;

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function newDeviceId() {
  return 'd' + crypto.randomBytes(8).toString('hex');
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function getToken(req) {
  return parseCookies(req)[COOKIE_NAME] || '';
}

export function setDeviceCookie(req, res, token) {
  const secure = req.socket && req.socket.encrypted ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secure}`);
}

export function clearDeviceCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function authenticate(req, store) {
  const token = getToken(req);
  if (!token) return null;
  const device = store.getDeviceByToken(sha256(token));
  if (!device || device.banned) return null;
  return device;
}

export function validClientKey(v) {
  const s = String(v || '');
  return /^[A-Za-z0-9_-]{16,128}$/.test(s);
}

export function validDeviceName(v) {
  const s = String(v || '').replace(/[\u0000-\u001f]/g, '').trim();
  return s.length >= 2 && s.length <= 16 ? s : null;
}
