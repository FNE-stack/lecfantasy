// ═══════════════════════════════════════════════════════════════════════════
// LEC Fantasy draft referee.
//
// Exists for exactly one reason: GitHub Pages is static, so a page that can
// write to the repo must contain the token, and a token in a public page is a
// token everybody has. This Worker keeps the token private and is the only
// thing that writes. Managers authenticate here; the page never sees a token.
//
// It is deliberately the *referee*, not a second rulebook: every legality
// decision comes from the same scoring.js the pages use, so the server can
// never disagree with what the boys saw on screen.
// ═══════════════════════════════════════════════════════════════════════════
import '../../scoring.js';

const S = globalThis.LECScoring;

const LEAGUE_PATH = 'data/league.json';
const PLAYERS_PATH = 'data/players.json';
const SESSION_TTL = 60 * 60 * 12;      // 12h, comfortably longer than a draft
const PBKDF2_ITERS = 100000;

// ── small helpers ──────────────────────────────────────────────────────────
const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' }, key, 256);
  return hex(bits);
}

// Length-independent compare so a wrong password can't be timed character by
// character. Overkill for four friends, but it costs one loop.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400'
  };
}
function json(env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(env) }
  });
}
function fail(env, status, error) { return json(env, { error }, status); }

// ── GitHub contents API (the only place the token is used) ─────────────────
async function ghGet(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`
            + `?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lec-fantasy-worker'
    }
  });
  if (!r.ok) throw new Error(`GitHub GET ${path} -> ${r.status}`);
  const j = await r.json();
  // base64 from GitHub is line-wrapped, and league.json may contain umlauts,
  // so decode bytes properly rather than treating them as latin-1 characters.
  const raw = Uint8Array.from(atob(j.content.replace(/\n/g, '')), c => c.charCodeAt(0));
  return { data: JSON.parse(new TextDecoder().decode(raw)), sha: j.sha };
}

async function ghPut(env, path, obj, sha, message) {
  const bytes = enc.encode(JSON.stringify(obj, null, 2) + '\n');
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'lec-fantasy-worker'
      },
      body: JSON.stringify({
        message, content: btoa(bin), sha, branch: env.GITHUB_BRANCH || 'main'
      })
    });
  if (r.status === 409 || r.status === 422) {
    const e = new Error('conflict'); e.conflict = true; throw e;
  }
  if (!r.ok) throw new Error(`GitHub PUT -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).content.sha;
}

function playerIndex(players) {
  const m = new Map();
  for (const p of (players && players.players) || []) m.set(p.id, p);
  return m;
}

// ── sessions ───────────────────────────────────────────────────────────────
async function newSession(env, managerId) {
  const tok = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.LEAGUE.put(`session:${tok}`, managerId, { expirationTtl: SESSION_TTL });
  return tok;
}
async function whoIs(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!tok) return null;
  return await env.LEAGUE.get(`session:${tok}`);
}

// ── routes ─────────────────────────────────────────────────────────────────

// Who exists, who has already claimed a slot, whose turn it is. No secrets.
async function handleState(env) {
  const { data: league } = await ghGet(env, LEAGUE_PATH);
  const claimed = {};
  for (const m of league.managers || []) {
    claimed[m.id] = (await env.LEAGUE.get(`mgr:${m.id}`)) !== null;
  }
  return json(env, {
    league,
    claimed,
    onTheClock: S.currentPicker(league),
    progress: S.draftProgress(league)
  });
}

// First visit: a manager slot is claimed by whoever sets a password first.
// Deliberately first-come — the link is the invite — and re-claiming is
// refused so nobody can take over a slot that is already in use.
async function handleClaim(env, body) {
  const { manager, displayName, password } = body;
  if (!manager || !password) return fail(env, 400, 'manager und password nötig');
  if (String(password).length < 6) return fail(env, 400, 'Passwort zu kurz (min. 6 Zeichen)');

  const { data: league, sha } = await ghGet(env, LEAGUE_PATH);
  const slot = (league.managers || []).find(m => m.id === manager);
  if (!slot) return fail(env, 404, 'unbekannter Manager-Slot');
  if (await env.LEAGUE.get(`mgr:${manager}`)) return fail(env, 409, 'Slot schon vergeben');

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  await env.LEAGUE.put(`mgr:${manager}`,
    JSON.stringify({ salt: hex(salt), hash, iters: PBKDF2_ITERS }));

  // A chosen display name is cosmetic, so a failure writing it must not lose
  // the claim that already succeeded above.
  if (displayName && displayName !== slot.name) {
    try {
      slot.name = String(displayName).slice(0, 32);
      await ghPut(env, LEAGUE_PATH, league, sha,
        `draft: ${manager} heißt jetzt ${slot.name}`);
    } catch (e) { /* name simply stays as configured */ }
  }
  return json(env, { ok: true, token: await newSession(env, manager), manager });
}

async function handleLogin(env, body) {
  const { manager, password } = body;
  if (!manager || !password) return fail(env, 400, 'manager und password nötig');
  const rec = await env.LEAGUE.get(`mgr:${manager}`, 'json');
  if (!rec) return fail(env, 404, 'Slot noch nicht übernommen');
  const hash = await pbkdf2(password, unhex(rec.salt));
  if (!safeEqual(hash, rec.hash)) return fail(env, 401, 'falsches Passwort');
  return json(env, { ok: true, token: await newSession(env, manager), manager });
}

// The actual referee. Re-reads league.json inside the retry loop so two
// managers picking at the same instant cannot both pass the turn check: the
// loser's PUT hits a stale sha, we re-read, and it is no longer their turn.
async function handlePick(env, request, body) {
  const me = await whoIs(env, request);
  if (!me) return fail(env, 401, 'nicht eingeloggt');
  const playerId = body.player;
  if (!playerId) return fail(env, 400, 'kein Spieler angegeben');

  const { data: players } = await ghGet(env, PLAYERS_PATH);
  const idx = playerIndex(players);

  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: league, sha } = await ghGet(env, LEAGUE_PATH);

    if (league.draft && league.draft.completed) return fail(env, 409, 'Draft ist gesperrt');
    const turn = S.currentPicker(league);
    if (turn === null) return fail(env, 409, 'Draft ist vorbei');
    if (turn !== me) return fail(env, 409, `nicht dein Zug — ${turn} ist dran`);

    const why = S.pickError(league, idx, me, playerId);
    if (why) return fail(env, 422, why);

    league.draft.picks.push({
      manager: me, player: playerId, at: new Date().toISOString()
    });
    if (S.currentPicker(league) === null) league.draft.completed = true;

    try {
      await ghPut(env, LEAGUE_PATH, league, sha, `draft: ${me} picks ${playerId}`);
      return json(env, {
        ok: true, picked: playerId,
        onTheClock: S.currentPicker(league),
        progress: S.draftProgress(league)
      });
    } catch (e) {
      if (!e.conflict) throw e;
      await new Promise(r => setTimeout(r, 150 + 200 * attempt));
    }
  }
  return fail(env, 503, 'zu viele gleichzeitige Picks — nochmal versuchen');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env) });
    }
    try {
      if (url.pathname === '/api/state' && request.method === 'GET') {
        return await handleState(env);
      }
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (url.pathname === '/api/claim') return await handleClaim(env, body);
        if (url.pathname === '/api/login') return await handleLogin(env, body);
        if (url.pathname === '/api/pick') return await handlePick(env, request, body);
      }
      return fail(env, 404, 'unbekannter Endpunkt');
    } catch (e) {
      // Never leak the token or GitHub internals to the page.
      console.error((e && e.stack) || String(e));
      return fail(env, 500, 'Serverfehler — siehe Worker-Log');
    }
  }
};
