// ═══════════════════════════════════════════════════════════════════════════
// auth.js — member passwords, member sessions, admin tokens.
//
// Members: salted PBKDF2 hash in KV (mgr:<id>), random session tokens in KV
// (session:<token>, manager id in the key metadata so the admin can list and
// revoke a member's sessions without reading each one).
// Admin: a signed token (HMAC of the expiry with ADMIN_PASSWORD). Stateless on
// purpose - admin access must keep working even if KV misbehaves.
// ═══════════════════════════════════════════════════════════════════════════
import { HttpError } from './store.js';

const enc = new TextEncoder();
const PBKDF2_ITERS = 100000;
export const SESSION_TTL = 60 * 60 * 24 * 30;   // 30 days: log in once per device
const ADMIN_TTL = 60 * 60 * 12;

export function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
export function randomHex(bytes) { return hex(crypto.getRandomValues(new Uint8Array(bytes))); }

async function pbkdf2(password, salt, iters) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, key, 256));
}

// Compare without an early exit, so timing reveals nothing.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6) throw new HttpError(400, 'Passwort zu kurz (min. 6 Zeichen)');
  if (pw.length > 200) throw new HttpError(400, 'Passwort zu lang');
}

export async function setMemberPassword(env, managerId, password) {
  checkPassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await env.LEAGUE.put(`mgr:${managerId}`, JSON.stringify({
    salt: hex(salt), hash: await pbkdf2(password, salt, PBKDF2_ITERS), iters: PBKDF2_ITERS,
  }));
}
export async function verifyMember(env, managerId, password) {
  const rec = await env.LEAGUE.get(`mgr:${managerId}`, 'json');
  if (!rec) return false;
  return safeEqual(await pbkdf2(password, unhex(rec.salt), rec.iters || PBKDF2_ITERS), rec.hash);
}
export async function hasPassword(env, managerId) {
  return (await env.LEAGUE.get(`mgr:${managerId}`)) !== null;
}
export async function deleteMember(env, managerId) {
  await env.LEAGUE.delete(`mgr:${managerId}`);
  await revokeSessions(env, managerId);
}

// ── member sessions ───────────────────────────────────────────────────────
export async function newSession(env, managerId) {
  const tok = randomHex(32);
  await env.LEAGUE.put(`session:${tok}`, managerId, { expirationTtl: SESSION_TTL, metadata: { m: managerId } });
  return tok;
}
function bearer(request) {
  const a = request.headers.get('Authorization') || '';
  return a.startsWith('Bearer ') ? a.slice(7).trim() : '';
}
export async function sessionManager(env, request) {
  const tok = bearer(request);
  if (!tok || tok.includes('.')) return null;   // admin tokens contain a dot
  return await env.LEAGUE.get(`session:${tok}`);
}
export async function endSession(env, request) {
  const tok = bearer(request);
  if (tok && !tok.includes('.')) await env.LEAGUE.delete(`session:${tok}`);
}
// Log a member out everywhere (password reset, removal, "kick").
export async function revokeSessions(env, managerId) {
  let cursor, n = 0;
  do {
    const page = await env.LEAGUE.list({ prefix: 'session:', cursor });
    for (const k of page.keys) {
      if (!managerId || (k.metadata && k.metadata.m === managerId)) { await env.LEAGUE.delete(k.name); n++; }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return n;
}
export async function sessionCounts(env) {
  const counts = {};
  let cursor;
  do {
    const page = await env.LEAGUE.list({ prefix: 'session:', cursor });
    for (const k of page.keys) { const m = k.metadata && k.metadata.m; if (m) counts[m] = (counts[m] || 0) + 1; }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return counts;
}

// ── admin ─────────────────────────────────────────────────────────────────
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
export const adminUser = env => String(env.ADMIN_USER || 'admin').trim().toLowerCase();
export async function adminLogin(env, username, password) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(500, 'ADMIN_PASSWORD ist nicht gesetzt (wrangler secret put ADMIN_PASSWORD)');
  // hash both sides so the comparison is length-independent
  const a = await hmac('cmp', String(password || '')), b = await hmac('cmp', env.ADMIN_PASSWORD);
  // a missing name is accepted: an admin page still cached from before the
  // name field existed only sends the password, and the password is the secret
  const userOk = username === undefined || username === null || String(username).trim().toLowerCase() === adminUser(env);
  if (!safeEqual(a, b) || !userOk) {
    await new Promise(r => setTimeout(r, 600));   // slows guessing down
    throw new HttpError(401, 'Admin-Name oder Passwort falsch');
  }
  const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL;
  return { token: `${exp}.${await hmac(env.ADMIN_PASSWORD, 'admin:' + exp)}`, exp };
}
export async function isAdmin(env, request) {
  const tok = bearer(request);
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || !env.ADMIN_PASSWORD) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(env.ADMIN_PASSWORD, 'admin:' + exp));
}
