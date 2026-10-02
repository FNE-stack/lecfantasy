// ═══════════════════════════════════════════════════════════════════════════
// Backups. league.json already has its full history in git (Admin → Verlauf);
// what lives only in KV - chat, pick'em tips before the reveal, waiver
// claims, watchlists - would be lost with it. A backup is one JSON snapshot of
// both, kept in KV as `backup:<YYYY-MM-DD[-n]>`.
//
// Automatic: every morning from 05:00 (German time), once per day, and only
// if something changed since the last one - so in practice one per game day.
// The newest 60 are kept. KV listings lag up to a minute behind writes, so
// the list of backups is its own key (`backup:index`), not a KV listing.
// Logins (salted password hashes, never plaintext) are kept server-side so a
// restored member can log in again; they are stripped from every download.
// Never stored: sessions, push subscriptions, the invite.
// ═══════════════════════════════════════════════════════════════════════════
import { S, HttpError, readLeagueFresh, writeLeague, publicData, playerIndex } from './store.js';

const KEEP = 60;
const KV_PARTS = { tips: 'pick:', claims: 'claims:', queues: 'queue:' };

async function listAll(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const r = await env.LEAGUE.list({ prefix, cursor });
    keys.push(...r.keys);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return keys;
}

async function hashOf(obj) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(obj)));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

// the last game day that has been played (for the label)
async function lastGameday(env) {
  const sch = await publicData(env, 'schedule.json', 300).catch(() => null);
  const done = ((sch && sch.events) || []).filter(e => e.state === 'completed').sort((a, b) => b.start.localeCompare(a.start))[0];
  if (!done) return '';
  const day = new Date(done.start).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit' });
  const split = String(done.tournament || '').replace(/^lec_/, '').replace(/_\d{4}$/, '').replace(/_/g, ' ');
  return `nach Spieltag ${day} (${split}${done.block ? ' · ' + done.block : ''})`;
}

export async function snapshot(env) {
  const { data, sha } = await readLeagueFresh(env);
  const kv = { chat: (await env.LEAGUE.get('chat', 'json')) || [] };
  for (const [part, prefix] of Object.entries(KV_PARTS)) {
    kv[part] = {};
    for (const k of await listAll(env, prefix)) kv[part][k.name] = await env.LEAGUE.get(k.name, 'json');
  }
  kv.logins = {};
  for (const m of data.managers || []) { const rec = await env.LEAGUE.get(`mgr:${m.id}`, 'json'); if (rec) kv.logins[`mgr:${m.id}`] = rec; }
  return { v: 1, at: new Date().toISOString(), sha, league: data, kv };
}

async function readIndex(env) {
  const idx = await env.LEAGUE.get('backup:index', 'json');
  if (idx) return idx;
  // first use (or index lost): rebuild once from the KV listing
  return (await listAll(env, 'backup:2')).map(k => Object.assign({ id: k.name.slice(7) }, k.metadata || {}))
    .filter(b => b.at).sort((a, b) => b.at.localeCompare(a.at));
}

async function store(env, snap, label, onDay) {
  const hash = await hashOf({ league: snap.league, kv: snap.kv });
  const day = onDay || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });   // YYYY-MM-DD
  const index = await readIndex(env);
  const existing = new Set(index.map(b => 'backup:' + b.id));
  let id = 'backup:' + day, n = 1;
  while (existing.has(id)) id = `backup:${day}-${++n}`;
  const body = JSON.stringify(Object.assign({}, snap, { label, hash }));
  const meta = { at: snap.at, label, hash, size: body.length, managers: (snap.league.managers || []).length,
                 picks: ((snap.league.draft || {}).picks || []).length, chat: snap.kv.chat.length };
  await env.LEAGUE.put(id, body, { metadata: meta });
  await env.LEAGUE.put('backup:last', JSON.stringify({ id, day, hash }));
  // newest first; keep the newest KEEP
  const next = [Object.assign({ id: id.slice(7) }, meta)].concat(index).sort((a, b) => b.at.localeCompare(a.at));
  for (const old of next.slice(KEEP)) await env.LEAGUE.delete('backup:' + old.id);
  await env.LEAGUE.put('backup:index', JSON.stringify(next.slice(0, KEEP)));
  return { id: id.slice(7), meta };
}

export async function backupCron(env, at) {
  const now = new Date(at || Date.now());
  if (S.berlinParts(now.getTime()).h < 5) return null;
  const day = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const last = (await env.LEAGUE.get('backup:last', 'json')) || {};
  if (last.day === day) return null;
  const snap = await snapshot(env);
  const hash = await hashOf({ league: snap.league, kv: snap.kv });
  if (hash === last.hash) { await env.LEAGUE.put('backup:last', JSON.stringify(Object.assign({}, last, { day }))); return { skipped: 'unverändert' }; }
  return store(env, snap, await lastGameday(env) || 'täglich', day);
}

export async function backupList(env) {
  return { backups: await readIndex(env), keep: KEEP };
}
async function backupRaw(env, id) {
  const b = await env.LEAGUE.get('backup:' + String(id || ''), 'json');
  if (!b) throw new HttpError(404, 'Backup nicht gefunden');
  return b;
}
// for download: everything except the login hashes
export async function backupGet(env, id) {
  const b = await backupRaw(env, id);
  b.kv = Object.assign({}, b.kv);
  delete b.kv.logins;
  return b;
}
export async function backupDelete(env, id) {
  const index = await readIndex(env);
  if (!index.some(b => b.id === id)) throw new HttpError(404, 'Backup nicht gefunden');
  await env.LEAGUE.delete('backup:' + id);
  await env.LEAGUE.put('backup:index', JSON.stringify(index.filter(b => b.id !== id)));
  return { message: `Backup ${id} gelöscht` };
}
export async function backupNow(env, label) {
  return store(env, await snapshot(env), String(label || 'manuell').slice(0, 80));
}

// Restore a stored backup (id) or an uploaded file (data). Takes a safety
// backup of the current state first, so a restore is itself undoable.
export async function backupRestore(env, body) {
  const snap = body.data || await backupRaw(env, body.id);
  if (!snap || snap.v !== 1 || !snap.league || !snap.kv) throw new HttpError(400, 'Das ist keine gültige Backup-Datei.');
  const players = await playerIndex(env).catch(() => null);
  const v = S.validateLeague(snap.league, players);
  if (v.errors.length && !body.force) throw new HttpError(422, 'Backup hat Fehler: ' + v.errors.map(e => e.msg).join('; ') + ' — nur mit „trotzdem“.', { validation: v });
  const safety = await backupNow(env, 'automatisch vor Wiederherstellung');
  const when = new Date(snap.at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
  await writeLeague(env, () => snap.league, `admin: Backup vom ${when} wiederhergestellt`, { allowInvalid: !!body.force });
  await env.LEAGUE.put('chat', JSON.stringify(snap.kv.chat || []));
  for (const [part, prefix] of Object.entries(KV_PARTS)) {
    const want = snap.kv[part] || {};
    for (const k of await listAll(env, prefix)) if (!(k.name in want)) await env.LEAGUE.delete(k.name);
    for (const [k, val] of Object.entries(want)) if (k.startsWith(prefix)) await env.LEAGUE.put(k, JSON.stringify(val));
  }
  // logins: bring back missing ones, never overwrite a password changed since
  for (const [k, rec] of Object.entries((!body.data && snap.kv.logins) || {})) {
    if (/^mgr:[\w-]+$/.test(k) && !(await env.LEAGUE.get(k))) await env.LEAGUE.put(k, JSON.stringify(rec));
  }
  const noLogin = [];
  for (const m of snap.league.managers || []) if (!(await env.LEAGUE.get(`mgr:${m.id}`))) noLogin.push(m.name);
  return { message: `Backup vom ${when} wiederhergestellt. Der Stand davor liegt als Backup ${safety.id}.`
    + (noLogin.length ? ` Ohne Passwort (unter Mitglieder neu setzen): ${noLogin.join(', ')}.` : ''), noLogin };
}
