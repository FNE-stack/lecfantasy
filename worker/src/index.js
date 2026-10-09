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
//            GET|POST|DELETE /api/chat, POST /api/chat/mute
//            GET /api/event?slug=, POST /api/event/team|pickem
//   admin    POST /api/admin/login, GET /api/admin/state|health|history,
//            GET /api/admin/backups|backup?id=, POST /api/admin/backup (create|restore)
//            POST /api/admin/op|invite|stats|broadcast|hall, GET|POST|DELETE /api/admin/chat
// ═══════════════════════════════════════════════════════════════════════════
import { S, HttpError, readLeague, playerIndex, publicData } from './store.js';
import { setMemberPassword, verifyMember, newSession, sessionManager, endSession, adminLogin, isAdmin,
         safeEqual } from './auth.js';
import { addMember, makePick, autoPickIfDue, deadline, tradeAction, nameKey, claimsOf, runWaivers, draftSchedule,
         setLineup, pickemState, savePickem, revealPickems } from './draft.js';
import { runOp, adminState, rotateInvite, health, runStats, broadcast, leagueHistory } from './admin.js';
import { subscribe, unsubscribe, notify } from './push.js';
import { eventState, eventSaveTeam, eventSavePickem, eventCron, eventAdmin } from './events.js';
import { testStart, testEnd, runBots, botPickems, botTrade, botChat, botEvents } from './testmode.js';
import { backupCron, backupList, backupGet, backupNow, backupRestore, backupDelete } from './backup.js';
import { chatState, chatLast, chatPost, chatDelete, chatMute, lineupReminders, recapPush, hallCron, hallAdmin } from './extras.js';

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
  const bots = await runBots(env, league).catch(() => null);   // test mode
  if (bots) league = bots;
  const m = (league.managers || []).find(x => x.id === me);
  if (!m) throw new HttpError(401, 'Dein Zugang existiert nicht mehr — frag den Admin.');
  return {
    league, me: { id: m.id, name: m.name },
    status: S.draftStatus(league), onTheClock: S.currentPicker(league), progress: S.draftProgress(league),
    deadline: deadline(league), serverTime: new Date().toISOString(),
    claims: S.transferRules(league).faMode === 'waiver' ? await claimsOf(env, me) : [],
    nextWaiver: S.transferRules(league).faMode === 'waiver' ? S.nextWaiverRun(league) : null,
    autoPicked: auto && auto.changed ? { manager: auto.manager, player: auto.picked } : null,
    chatLast: await chatLast(env).catch(() => null),
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
    if (String(body.name || '').trim().toLowerCase() === 'admin') {
      throw new HttpError(409, 'Das ist der Admin-Zugang — deine Seite ist noch eine alte Version. Bitte neu laden (Strg+F5, am Handy Tab schließen und neu öffnen) oder direkt …/#/admin öffnen.');
    }
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
    if (p === '/api/admin/hall' && method === 'POST') return hallAdmin(env, body);
    if (p === '/api/admin/event' && method === 'POST') {
      const r = await eventAdmin(env, body);
      if (body.action === 'pickem') await botEvents(env, r.league).catch(() => 0);
      return { message: r.message };
    }
    if (p === '/api/admin/test' && method === 'POST') {
      if (body.action === 'start') return testStart(env, body);
      if (body.action === 'end') return testEnd(env);
      if (body.action === 'pickem') {
        const season = await publicData(env, 'season.json', 300);
        const split = body.split || (season.tournaments[season.tournaments.length - 1] || {}).slug;
        const min = Math.max(1, Math.min(120, Number(body.minutes) || 5));
        const r = await runOp(env, { op: 'pickemOpen', split, lockAt: new Date(Date.now() + min * 60000).toISOString(), questions: [
          { type: 'champion', points: 10 }, { type: 'finalist', points: 5 }, { type: 'firstRegular', points: 5 }, { type: 'mostKills', points: 5 },
          { type: 'mostPicked', points: 5 }, { type: 'longestGame', points: 5 }] });
        await botPickems(env, r.league).catch(() => 0);
        return { message: `Test-Pick'em für ${split} offen — Sperre in ${min} Min. Die Bots haben schon getippt.` };
      }
      if (body.action === 'replay') {
        const { eventAdmin: ea } = await import('./events.js');
        const slug = String(body.slug || '');
        const raw = await publicData(env, `events/${slug}.json`, 120);
        if (!raw || !(raw.schedule || []).length || !(raw.games || []).length) throw new HttpError(404, 'Für dieses Event gibt es keine fertigen Daten zum Wiederholen.');
        const plan = S.eventReplayPlan(raw, Math.max(10, Math.min(120, Number(body.minutes) || 30)), Math.max(0, Math.min(30, body.lead === undefined || body.lead === null || body.lead === '' ? 10 : Number(body.lead) || 0)));
        const { data } = await readLeague(env);
        if (!(data.events || {})[slug]) await ea(env, { action: 'create', slug, name: `${raw.name || slug} ${raw.year || ''} (Wiederholung)`, video: body.video || '' });
        const { writeLeague } = await import('./store.js');
        const r = await writeLeague(env, l => { const ev = l.events[slug]; ev.replay = plan; ev.lineups = {}; ev.revealed = []; ev.pickem = { revealed: false, lockAt: null,
          questions: ['champion', 'advance8', 'winnerRegion', 'bestLec', 'mostKills', 'mostDeaths', 'mostPicked', 'shortestGame', 'totalGames'].map((type, i) => ({ id: 'q' + (i + 1), type, points: type === 'champion' ? 10 : type === 'advance8' ? 2 : 5 })) };
          ev.pickemKo = { revealed: false, lockAt: null, questions: ['koSemis', 'koFinal', 'champion', 'finalScore'].map((type, i) => ({ id: 'q' + (i + 1), type, points: type === 'koSemis' ? 5 : type === 'koFinal' ? 10 : type === 'champion' ? 20 : 10 })) }; return l; }, `test: ${slug} als Wiederholung`);
        await botEvents(env, r.league).catch(() => 0);
        return { message: `${raw.name} läuft als Wiederholung: Teams & Tipps bis ${new Date(plan.from).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })} Uhr, danach spielt sich das Event in ~${Math.round((Number(body.minutes) || 30) * 1.4)} Min ab. Die Bots haben schon gebaut & getippt.` };
      }
      if (body.action === 'hall') {
        const season = await publicData(env, 'season.json', 300);
        const out = [];
        for (const t of season.tournaments || []) out.push((await hallAdmin(env, { split: t.slug })).message);
        return { message: out.join(' · ') };
      }
      throw new HttpError(400, 'unbekannte Test-Aktion');
    }
    if (p === '/api/admin/backups') return backupList(env);
    if (p === '/api/admin/backup' && method === 'GET') return backupGet(env, url.searchParams.get('id'));
    if (p === '/api/admin/backup' && method === 'POST') {
      if (body.action === 'restore') return backupRestore(env, body);
      if (body.action === 'delete') return backupDelete(env, String(body.id || ''));
      const r = await backupNow(env, body.label || 'manuell');
      return { message: `Backup ${r.id} gespeichert`, backup: r };
    }
    if (p === '/api/admin/chat') {
      if (method === 'POST') return chatPost(env, 'admin', body.text);
      if (method === 'DELETE') return chatDelete(env, 'admin', body.id);
      return chatState(env, null);
    }
    if (p === '/api/admin/op' && method === 'POST') {
      const r = await runOp(env, body);
      if (r.league) {
        const b = await runBots(env, r.league).catch(() => null);
        if (b) r.league = b;
        pingNext(env, ctx, r.league);
      }
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
    const b = await runBots(env, r.league).catch(() => null);   // test mode: bots answer at once
    if (b) r.league = b;
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
    let t = await tradeAction(env, me, body);
    if (body.action === 'propose' && t && t.id) { const ok = await botTrade(env, t).catch(() => null); if (ok !== null) t = Object.assign({}, t, { status: ok ? 'accepted' : 'rejected', bot: true }); }
    // tell the other side (best effort, never blocks the answer)
    if (t && t.id && ctx && ctx.waitUntil) {
      const who = body.action === 'propose' ? t.to : body.action === 'respond' ? t.from : null;
      const text = body.action === 'propose' ? 'Du hast ein Trade-Angebot.' : t.status === 'accepted' ? 'Dein Trade wurde angenommen.'
        : t.status === 'agreed' ? 'Dein Trade wurde angenommen und wartet auf den Admin.' : 'Dein Trade wurde abgelehnt.';
      if (who) ctx.waitUntil(notify(env, [who], { title: 'Transfers', body: text, url: './#/transfers', tag: 'trade' }).catch(() => {}));
    }
    return { trade: t };
  }
  if (p === '/api/lineup' && method === 'POST') return setLineup(env, me, body);
  if (p === '/api/event' && method === 'GET') return eventState(env, me, url.searchParams.get('slug'));
  if (p === '/api/event/team' && method === 'POST') return eventSaveTeam(env, me, body);
  if (p === '/api/event/pickem' && method === 'POST') return eventSavePickem(env, me, body);
  if (p === '/api/chat/mute' && method === 'POST') return chatMute(env, me, !!body.mute);
  if (p === '/api/chat') {
    if (method === 'POST') {
      const r = await chatPost(env, me, body.text);
      if (ctx && ctx.waitUntil) ctx.waitUntil(botChat(env, me).catch(() => null));   // test mode
      return r;
    }
    if (method === 'DELETE') return chatDelete(env, me, body.id);
    return chatState(env, me);
  }
  if (p === '/api/pickem' && method === 'GET') return { pickems: await pickemState(env, me) };
  if (p === '/api/pickem' && method === 'POST') return savePickem(env, me, body);
  if (p === '/api/push/key' && method === 'GET') return { key: env.VAPID_PUBLIC || null };
  if (p === '/api/push' && method === 'POST') return { devices: await subscribe(env, me, body.subscription) };
  if (p === '/api/push' && method === 'DELETE') { await unsubscribe(env, me, body.endpoint); return { ok: true }; }
  if (p === '/api/push/test' && method === 'POST') {
    return notify(env, [me], { title: 'LEC Fantasy', body: 'Benachrichtigungen funktionieren ✓', url: './#/', tag: 'test' });
  }
  throw new HttpError(404, 'unbekannter Endpunkt');
}

// Push once when a pick'em opens, and once 24 h before its lock to everyone
// who has not tipped yet. KV flags make each message go out a single time.
async function pickemNotices(env, data, all) {
  const open = Object.entries(data.pickems || {}).filter(([, pe]) => pe && !pe.revealed);
  if (!open.length) return;
  const schedule = await publicData(env, 'schedule.json', 60);
  for (const [split, pe] of open) {
    const lock = Date.parse(S.pickemLock(data, schedule, split) || '');
    if (!lock || lock <= Date.now()) continue;
    const name = split.replace(/^lec_/, '').replace(/_\d{4}$/, '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
    const until = new Date(lock).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const soon = lock - Date.now() < 24 * 3600e3;
    if (!(await env.LEAGUE.get(`pkn:${split}:open`))) {
      await env.LEAGUE.put(`pkn:${split}:open`, '1');
      if (soon) await env.LEAGUE.put(`pkn:${split}:24h`, '1');
      await notify(env, all, { title: `Pick'em ${name} ist offen`, body: `${(pe.questions || []).length} Fragen — tippen bis ${until} Uhr.`, url: './#/pickem', tag: 'pickem-' + split });
    } else if (soon && !(await env.LEAGUE.get(`pkn:${split}:24h`))) {
      await env.LEAGUE.put(`pkn:${split}:24h`, '1');
      const missing = [];
      for (const id of all) if (!(await env.LEAGUE.get(`pick:${split}:${id}`))) missing.push(id);
      if (missing.length) await notify(env, missing, { title: "Pick'em: noch 24 Stunden", body: `Du hast für ${name} noch nicht getippt — Sperre ${until} Uhr.`, url: './#/pickem', tag: 'pickem-' + split });
    }
  }
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
    let data;
    try { data = (await readLeague(env)).data; } catch (e) { console.error('cron read', e && e.message); return; }
    const all = (data.managers || []).map(m => m.id);
    try {
      const r = await autoPickIfDue(env, data);
      if (r && r.changed) pingNext(env, ctx, r.league);
    } catch (e) { console.error('cron autopick', e && e.message); }
    // draft appointment: reminder + optional auto-start
    try {
      const d = await draftSchedule(env, data);
      if (d && d.remind) {
        const t = new Date(data.draft.scheduledAt).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
        await notify(env, all, { title: 'Draft heute', body: `${data.name || 'LEC Fantasy'}: der Draft startet um ${t} Uhr.`, url: './#/draft', tag: 'draft-remind' });
      }
      if (d && d.started) {
        await notify(env, all, { title: 'Der Draft läuft!', body: 'Ab jetzt wird gepickt.', url: './#/draft', tag: 'draft-start' });
        pingNext(env, ctx, d.started);
      }
    } catch (e) { console.error('cron schedule', e && e.message); }
    // pick'em: reveal everyone's picks once a split has started
    try { await revealPickems(env); } catch (e) { console.error('cron pickem', e && e.message); }
    try { await pickemNotices(env, data, all); } catch (e) { console.error('cron pickem push', e && e.message); }
    try { await lineupReminders(env, data); } catch (e) { console.error('cron lineup reminder', e && e.message); }
    try { await recapPush(env, data); } catch (e) { console.error('cron recap', e && e.message); }
    try { await hallCron(env, data); } catch (e) { console.error('cron hall', e && e.message); }
    try { await backupCron(env); } catch (e) { console.error('cron backup', e && e.message); }
    try { await eventCron(env, data); } catch (e) { console.error('cron events', e && e.message); }
    if (data.testMode && data.testMode.on) {
      try { await runBots(env, data); await botPickems(env, data); await botEvents(env, data); } catch (e) { console.error('cron bots', e && e.message); }
    }
    // waivers at their scheduled times (German time); each slot runs once
    try {
      const slot = S.lastWaiverSlot(data);
      const rules = S.transferRules(data);
      if (slot && rules.freeAgents && rules.faMode === 'waiver') {
        const last = Number(await env.LEAGUE.get('waiver:last')) || 0;
        // first run after deploy: only pick up a slot from the last 15 minutes
        if (slot > last && (last || Date.now() - slot < 15 * 60000)) {
          const r = await runWaivers(env);
          await env.LEAGUE.put('waiver:last', String(slot));
          if (r && (r.awarded || r.failed)) {
            const by = {};
            for (const a of r.awarded) (by[a.manager] = by[a.manager] || []).push('✓ ' + a.in);
            for (const f of r.failed) (by[f.manager] = by[f.manager] || []).push('✗ ' + f.in);
            for (const id of Object.keys(by)) {
              const won = r.awarded.filter(a => a.manager === id).length;
              await notify(env, [id], { title: 'Waiver-Ergebnis', body: won ? `Du hast ${won} Spieler bekommen.` : 'Diesmal kein Spieler für dich.', url: './#/transfers', tag: 'waiver' });
            }
          }
        }
      }
    } catch (e) { console.error('cron waiver', e && e.message); }
  },
};
