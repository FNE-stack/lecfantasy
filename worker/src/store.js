// ═══════════════════════════════════════════════════════════════════════════
// store.js — everything the Worker reads and writes.
//
// The league lives in a git repo (DATA_REPO, ideally private). Git gives us
// three things for free: strong consistency with optimistic locking (the
// blob sha), a full history of every change, and restore-to-any-version.
// EVERY league write goes through writeLeague(): conflict retry + validation,
// so no code path can save a broken league.json.
// ═══════════════════════════════════════════════════════════════════════════
import '../../scoring.js';
export const S = globalThis.LECScoring;

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const enc = new TextEncoder();
const UA = 'lec-fantasy-worker';

export function cfg(env) {
  const site = env.GITHUB_REPO;
  const data = env.DATA_REPO || site;
  return {
    site, data,
    branch: env.GITHUB_BRANCH || 'main',
    // in the public site repo the league sits under data/, in a dedicated
    // data repo at the root
    leaguePath: env.LEAGUE_PATH || (data === site ? 'data/league.json' : 'league.json'),
    pages: (env.PAGES_URL || 'https://fne-stack.github.io/lecfantasy').replace(/\/+$/, ''),
  };
}

// GitHub's API now and then answers 502/503/504 (or 429) for a moment. Reads
// are safe to repeat, so they retry here with backoff. Writes are NOT retried
// blindly - a 502 can arrive after the write landed - see writeLeague.
async function gh(env, url, init) {
  const req = () => fetch(url, Object.assign({}, init, {
    headers: Object.assign({
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': UA,
    }, (init && init.headers) || {}),
  }));
  const isRead = !init || !init.method || init.method === 'GET';
  let r = await req();
  for (let i = 0; isRead && i < 3 && (r.status >= 500 || r.status === 429); i++) {
    await new Promise(res => setTimeout(res, 300 * (i + 1) * (i + 1)));
    r = await req();
  }
  return r;
}

function b64decodeUtf8(b64) {
  const raw = Uint8Array.from(atob(b64.replace(/\n/g, '')), c => c.charCodeAt(0));
  return new TextDecoder().decode(raw);
}
function b64encodeUtf8(text) {
  let bin = '';
  for (const b of enc.encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function ghGetFile(env, repo, path, ref) {
  const c = cfg(env);
  const r = await gh(env, `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref || c.branch)}`);
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new HttpError(502, `GitHub GET ${path} -> ${r.status}`);
  const j = await r.json();
  return { data: JSON.parse(b64decodeUtf8(j.content)), sha: j.sha };
}

export async function ghPutFile(env, repo, path, obj, sha, message) {
  const c = cfg(env);
  const body = { message, content: b64encodeUtf8(JSON.stringify(obj, null, 2) + '\n'), branch: c.branch };
  if (sha) body.sha = sha;
  const r = await gh(env, `https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.status === 409 || r.status === 422) { const e = new Error('conflict'); e.conflict = true; throw e; }
  if (r.status >= 500 || r.status === 429) {
    // ambiguous: the write may or may not have landed - the caller checks
    const e = new HttpError(502, `GitHub PUT ${path} -> ${r.status}`); e.transient = true; throw e;
  }
  if (!r.ok) throw new HttpError(502, `GitHub PUT ${path} -> ${r.status} ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).content.sha;
}

// ── league ────────────────────────────────────────────────────────────────
const LEAGUE_CACHE = 'https://cache.lecfantasy.internal/league/v2';
const LEAGUE_TTL = 3;
const edge = () => (typeof caches !== 'undefined' ? caches.default : null);

// Cached read for the many polling tabs. Writes always use readLeagueFresh.
export async function readLeague(env) {
  const c = edge();
  if (c) {
    const hit = await c.match(LEAGUE_CACHE);
    if (hit) return await hit.json();
  }
  const fresh = await readLeagueFresh(env);
  if (c) {
    await c.put(LEAGUE_CACHE, new Response(JSON.stringify(fresh), {
      headers: { 'Cache-Control': `public, max-age=${LEAGUE_TTL}` } }));
  }
  return fresh;
}
export async function readLeagueFresh(env) {
  const c = cfg(env);
  const r = await ghGetFile(env, c.data, c.leaguePath);
  if (!r.data) throw new HttpError(500, `league.json nicht gefunden in ${c.data}/${c.leaguePath}`);
  return r;
}
export async function purgeLeague() {
  const c = edge();
  if (c) await c.delete(LEAGUE_CACHE);
}

// The one and only way to change the league.
//   mutate(league) -> the league to write, or null for "nothing to do".
//   It runs again on every retry against the freshest version, so checks
//   inside it (whose turn, is the slot free) are always made on current data.
// Refuses to write a league that fails validation unless opts.allowInvalid.
export async function writeLeague(env, mutate, message, opts) {
  opts = opts || {};
  const c = cfg(env);
  let players = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, sha } = await readLeagueFresh(env);
    const before = JSON.stringify(data);
    const next = await mutate(JSON.parse(before));
    if (!next || JSON.stringify(next) === before) return { league: data, sha, changed: false };
    if (!opts.allowInvalid) {
      players = players || await playerIndex(env).catch(() => null);
      const v = S.validateLeague(next, players);
      if (v.errors.length) {
        throw new HttpError(422, 'Änderung abgelehnt — sie würde league.json beschädigen: '
          + v.errors.map(e => e.msg).join('; '), { validation: v });
      }
    }
    try {
      const newSha = await ghPutFile(env, c.data, c.leaguePath, next, sha, typeof message === 'function' ? message(next) : message);
      await purgeLeague();
      return { league: next, sha: newSha, changed: true };
    } catch (e) {
      if (e.transient) {
        // GitHub said 5xx. Did our write land anyway? Then we are done - and
        // must NOT apply the change again (an undo would undo two picks).
        await new Promise(r => setTimeout(r, 500 + 400 * attempt));
        const now = await readLeagueFresh(env).catch(() => null);
        if (now && JSON.stringify(now.data) === JSON.stringify(next)) {
          await purgeLeague();
          return { league: next, sha: now.sha, changed: true };
        }
        continue;   // it did not land: apply again on the freshest version
      }
      if (!e.conflict) throw e;
      await new Promise(r => setTimeout(r, 120 + 180 * attempt + Math.random() * 120));
    }
  }
  throw new HttpError(503, 'Zu viele gleichzeitige Änderungen — bitte nochmal versuchen.');
}

// Commits to the league file, newest first.
export async function leagueHistory(env, n) {
  const c = cfg(env);
  const r = await gh(env, `https://api.github.com/repos/${c.data}/commits?path=${encodeURIComponent(c.leaguePath)}&sha=${c.branch}&per_page=${n || 40}`);
  if (!r.ok) throw new HttpError(502, `GitHub history -> ${r.status}`);
  return (await r.json()).map(x => ({
    sha: x.sha, short: x.sha.slice(0, 7), date: x.commit.author.date,
    message: x.commit.message.split('\n')[0], author: x.commit.author.name,
  }));
}
export async function leagueAt(env, sha) {
  const c = cfg(env);
  const r = await ghGetFile(env, c.data, c.leaguePath, sha);
  if (!r.data) throw new HttpError(404, 'Version nicht gefunden');
  return r.data;
}

// ── public site data (read via Pages, cheap and cached at the edge) ───────
async function pagesJson(env, file, ttl) {
  const url = `${cfg(env).pages}/data/${file}`;
  const r = await fetch(url, { cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw new HttpError(502, `${file} nicht ladbar (${r.status})`);
  return r.json();
}
export async function playerIndex(env) {
  const p = await pagesJson(env, 'players.json', 120);
  return new Map((p.players || []).map(x => [x.id, x]));
}
export async function seasonPoints(env, league) {
  const st = await pagesJson(env, 'stats.json', 300);
  const pts = new Map();
  for (const g of st.games || []) pts.set(g.player, (pts.get(g.player) || 0) + S.gamePoints(g, league.scoring));
  return pts;
}
export async function pagesMeta(env) {
  const out = {};
  for (const f of ['players.json', 'stats.json', 'schedule.json']) {
    try { const j = await pagesJson(env, f, 30); out[f] = { updated: j.updated || null, tournament: j.tournament || null }; }
    catch (e) { out[f] = { error: e.message }; }
  }
  return out;
}

// ── files in the public site repo (stat corrections, config) ──────────────
export async function writeSiteFile(env, path, mutate, message) {
  const c = cfg(env);
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, sha } = await ghGetFile(env, c.site, path);
    const next = await mutate(data ? JSON.parse(JSON.stringify(data)) : null);
    if (!next) return data;
    try { await ghPutFile(env, c.site, path, next, sha, message); return next; }
    catch (e) {
      if (e.transient) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        const now = await ghGetFile(env, c.site, path).catch(() => null);
        if (now && JSON.stringify(now.data) === JSON.stringify(next)) return next;
        continue;
      }
      if (!e.conflict) throw e;
      await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  throw new HttpError(503, 'Konflikt beim Schreiben — nochmal versuchen.');
}

export async function githubRaw(env, path, init) {
  return gh(env, `https://api.github.com${path}`, init);
}
