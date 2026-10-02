// ═══════════════════════════════════════════════════════════════════════════
// LEC Fantasy Worker — the only thing that holds the GitHub token and the only
// thing that writes. Static pages can't keep secrets, so every write and every
// read of league data (members, picks) goes through here, behind a login.
//
//   public   POST /api/invite   check an invite code (no member data)
//            POST /api/join     invite code + name + password -> member
//            POST /api/login    name + password -> session
//   member   GET  /api/state    league, me, clock (auto-pick runs here)
//            POST /api/pick · /api/logout · /api/queue · /api/trade · /api/push
//   admin    POST /api/admin/login, GET /api/admin/state|health|history,
//            POST /api/admin/op|invite|stats|broadcast
// ═══════════════════════════════════════════════════════════════════════════
import { S, HttpError, readLeague, playerIndex } from './store.js';
import { setMemberPassword, verifyMember, newSession, sessionManager, endSession, adminLogin, isAdmin,
         safeEqual } from './auth.js';
import { addMember, makePick, autoPickIfDue, deadline, tradeAction, nameKey } from './draft.js';
import { runOp, adminState, rotateInvite, health, runStats, broadcast, leagueHistory } from './admin.js';
import { subscribe, unsubscribe, notify } from './push.js';

function cors(env, request) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]),
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// Tell whoever was just put on the clock (push; best effort, never blocks).
function pingNext(env, ctx, league) {
  const next = S.currentPicker(league);
  if (!next || !ctx || !ctx.waitUntil) return;
  ctx.waitUntil(notify(env, [next], {
    title: 'Du bist dran!', body: `${league.name || 'LEC Fantasy'} — dein Pick im Draft.`, url: './#/draft', tag: 'turn',
  }).catch(() => {}));
}

async function memberState(env, me) {
  let { data: league } = await readLeague(env);
  const auto = await autoPickIfDue(env, league).catch(() => null);
  if (auto && auto.changed) league = auto.league;
  const m = (league.managers || []).find(x => x.id === me);
  if (!m) throw new HttpError(401, 'Dein Zugang existiert nicht mehr — frag den Admin.');
  return {
    league, me: { id: m.id, name: m.name },
    status: S.draftStatus(league), onTheClock: S.currentPicker(league), progress: S.draftProgress(league),
    deadline: deadline(league), serverTime: new Date().toISOString(),
    autoPicked: auto && auto.changed ? { manager: auto.manager, player: auto.picked } : null,
  };
}

async function checkInvite(env, code) {
  const inv = await env.LEAGUE.get('invite', 'json');
  if (!inv || !safeEqual(String(code || ''), inv.code)) throw new HttpError(404, 'Dieser Einladungslink ist ungültig oder abgelaufen.');
}

async function route(request, env, ctx) {
  const url = new URL(request.url), p = url.pathname, method = request.method;
  const body = method === 'POST' || method === 'PUT' || method === 'DELETE' ? await request.json().catch(() => ({})) : {};

  // ── public ──────────────────────────────────────────────────────────────
  if (p === '/api/invite' && method === 'POST') {
    await checkInvite(env, body.code);
    const { data: league } = await readLeague(env);
    const players = await playerIndex(env);
    return { ok: true, name: league.name, status: S.draftStatus(league),
             members: (league.managers || []).length, capacity: S.capacity(league, players) };
  }
  if (p === '/api/join' && method === 'POST') {
    await checkInvite(env, body.code);
    if (typeof body.password !== 'string' || body.password.length < 6) throw new HttpError(400, 'Passwort zu kurz (min. 6 Zeichen)');
    const m = await addMember(env, body.name);
    try { await setMemberPassword(env, m.id, body.password); }
    catch (e) {
      // the league write succeeded but the password didn't: the admin can set one
      throw new HttpError(500, 'Angemeldet, aber das Passwort konnte nicht gespeichert werden — gib dem Admin Bescheid.');
    }
    return { ok: true, token: await newSession(env, m.id), me: m };
  }
  if (p === '/api/login' && method === 'POST') {
    const { data: league } = await readLeague(env);
    const m = (league.managers || []).find(x => nameKey(x.name) === nameKey(body.name));
    if (!m || !(await verifyMember(env, m.id, String(body.password || '')))) {
      await new Promise(r => setTimeout(r, 400));
      throw new HttpError(401, 'Name oder Passwort falsch.');
    }
    return { ok: true, token: await newSession(env, m.id), me: { id: m.id, name: m.name } };
  }

  // ── admin ───────────────────────────────────────────────────────────────
  if (p === '/api/admin/login' && method === 'POST') return adminLogin(env, body.username, body.password);
  if (p.startsWith('/api/admin/')) {
    if (!(await isAdmin(env, request))) throw new HttpError(401, 'Admin-Login nötig');
    if (p === '/api/admin/state') return adminState(env);
    if (p === '/api/admin/health') return { checks: await health(env) };
    if (p === '/api/admin/history') return { commits: await leagueHistory(env, 50) };
    if (p === '/api/admin/invite' && method === 'POST') return { invite: await rotateInvite(env) };
    if (p === '/api/admin/stats' && method === 'POST') return runStats(env, body.tournament);
    if (p === '/api/admin/broadcast' && method === 'POST') return broadcast(env, body.text || '');
    if (p === '/api/admin/op' && method === 'POST') {
      const r = await runOp(env, body);
      if (r.league) pingNext(env, ctx, r.league);
      return r;
    }
    throw new HttpError(404, 'unbekannter Admin-Endpunkt');
  }

  // ── member ──────────────────────────────────────────────────────────────
  const me = await sessionManager(env, request);
  if (!me) throw new HttpError(401, 'Bitte einloggen.');

  if (p === '/api/state' && method === 'GET') {
    const st = await memberState(env, me);
    if (st.autoPicked) pingNext(env, ctx, st.league);
    return st;
  }
  if (p === '/api/pick' && method === 'POST') {
    if (!body.player) throw new HttpError(400, 'Kein Spieler angegeben');
    const r = await makePick(env, me, body.player, { by: 'member' });
    pingNext(env, ctx, r.league);
    return { ok: true, picked: r.picked, onTheClock: S.currentPicker(r.league), progress: S.draftProgress(r.league) };
  }
  if (p === '/api/logout' && method === 'POST') { await endSession(env, request); return { ok: true }; }
  if (p === '/api/queue') {
    if (method === 'PUT') {
      const q = Array.isArray(body.queue) ? body.queue.filter(x => typeof x === 'string').slice(0, 60) : [];
      await env.LEAGUE.put(`queue:${me}`, JSON.stringify(q));
      return { queue: q };
    }
    return { queue: (await env.LEAGUE.get(`queue:${me}`, 'json')) || [] };
  }
  if (p === '/api/trade' && method === 'POST') {
    const t = await tradeAction(env, me, body);
    // tell the other side (best effort, never blocks the answer)
    if (t && t.id && ctx && ctx.waitUntil) {
      const who = body.action === 'propose' ? t.to : body.action === 'respond' ? t.from : null;
      const text = body.action === 'propose' ? 'Du hast ein Trade-Angebot.' : t.status === 'accepted' ? 'Dein Trade wurde angenommen.'
        : t.status === 'agreed' ? 'Dein Trade wurde angenommen und wartet auf den Admin.' : 'Dein Trade wurde abgelehnt.';
      if (who) ctx.waitUntil(notify(env, [who], { title: 'Transfers', body: text, url: './#/transfers', tag: 'trade' }).catch(() => {}));
    }
    return { trade: t };
  }
  if (p === '/api/push/key' && method === 'GET') return { key: env.VAPID_PUBLIC || null };
  if (p === '/api/push' && method === 'POST') return { devices: await subscribe(env, me, body.subscription) };
  if (p === '/api/push' && method === 'DELETE') { await unsubscribe(env, me, body.endpoint); return { ok: true }; }
  if (p === '/api/push/test' && method === 'POST') {
    return notify(env, [me], { title: 'LEC Fantasy', body: 'Benachrichtigungen funktionieren ✓', url: './#/', tag: 'test' });
  }
  throw new HttpError(404, 'unbekannter Endpunkt');
}

export default {
  async fetch(request, env, ctx) {
    const headers = cors(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    try {
      const out = await route(request, env, ctx);
      return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error((e && e.stack) || String(e));
      // never leak the token or GitHub internals for unexpected errors
      const error = e instanceof HttpError ? e.message : 'Serverfehler — der Admin sieht Details im Worker-Log.';
      return new Response(JSON.stringify(Object.assign({ error }, e instanceof HttpError && e.extra ? e.extra : {})),
        { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
    }
  },
  // Backstop for the pick timer: even with nobody's page open, an overdue
  // auto-pick happens within a minute.
  async scheduled(event, env, ctx) {
    try {
      const { data } = await readLeague(env);
      const r = await autoPickIfDue(env, data);
      if (r && r.changed) pingNext(env, ctx, r.league);
    } catch (e) { console.error('cron', e && e.message); }
  },
};
