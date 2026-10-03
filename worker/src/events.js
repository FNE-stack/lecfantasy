// ═══════════════════════════════════════════════════════════════════════════
// Special events (First Stand, MSI, Worlds): budget teams + pick'em.
//
// Like the split pick'em, nothing a member saves is visible to the others
// before the lock: a stage's team waits in KV (`evt:<slug>:<stage>:<id>`), the
// event pick'em in `evp:<slug>:<id>`. The cron moves them into league.json once
// the stage (or the pick'em) has started. Rules: scoring.js (event*).
// ═══════════════════════════════════════════════════════════════════════════
import { S, HttpError, readLeague, readLeagueFresh, writeLeague, publicData } from './store.js';

// ev given: a test replay (ev.replay) is applied, so every check sees replay time
export async function eventData(env, slug, ev) {
  if (!/^[a-z0-9_]+$/.test(String(slug || ''))) throw new HttpError(400, 'Event fehlt');
  const d = await publicData(env, `events/${slug}.json`, 120);
  if (!d) throw new HttpError(404, 'Für dieses Event gibt es noch keine Daten.');
  return ev && ev.replay ? S.eventReplay(d, ev.replay) : d;
}
function eventOf(league, slug) {
  const ev = (league.events || {})[slug];
  if (!ev) throw new HttpError(404, 'Dieses Event ist in der Liga nicht angelegt.');
  return ev;
}
export function eventPickemLock(ev, evData) {
  const pe = ev.pickem || {};
  if (pe.lockAt) return Date.parse(pe.lockAt);
  const st = S.eventStages(evData).find(x => x.lock !== null);
  return st ? st.lock : null;
}

// my (secret) team for the open stage + my tips
export async function eventState(env, me, slug) {
  const { data: league } = await readLeague(env);
  const ev = eventOf(league, slug), d = await eventData(env, slug, ev);
  const stage = S.eventOpenStage(d);
  let team = stage === null ? null : await env.LEAGUE.get(`evt:${slug}:${stage}:${me}`, 'json');
  if (!team && stage !== null) team = S.eventLineup(ev, me, stage - 1);    // carried over from the last stage
  const tips = (ev.pickem && ev.pickem.revealed) ? ((ev.pickem.picks || {})[me] || {}) : ((await env.LEAGUE.get(`evp:${slug}:${me}`, 'json')) || {});
  const lock = eventPickemLock(ev, d);
  return { stage, team, tips, pickemLocked: !!(ev.pickem && (ev.pickem.revealed || (lock && Date.now() >= lock))), pickemLockAt: lock ? new Date(lock).toISOString() : null };
}

export async function eventSaveTeam(env, me, body) {
  const slug = String(body.slug || '');
  const { data: league } = await readLeagueFresh(env);
  const ev = eventOf(league, slug), d = await eventData(env, slug, ev);
  const stage = S.eventOpenStage(d);
  if (stage === null) throw new HttpError(409, 'Das Event ist vorbei — keine Änderungen mehr.');
  const sel = { players: (body.players || []).map(String), captain: String(body.captain || '') };
  const why = S.eventTeamError(ev, d, sel);
  if (why) throw new HttpError(400, why);
  await env.LEAGUE.put(`evt:${slug}:${stage}:${me}`, JSON.stringify(sel));
  return { stage, team: sel };
}

export async function eventSavePickem(env, me, body) {
  const slug = String(body.slug || '');
  const { data: league } = await readLeagueFresh(env);
  const ev = eventOf(league, slug), d = await eventData(env, slug, ev);
  const pe = ev.pickem;
  if (!pe || !(pe.questions || []).length) throw new HttpError(404, 'Für dieses Event ist noch kein Pick\'em offen.');
  const lock = eventPickemLock(ev, d);
  if (pe.revealed || (lock && Date.now() >= lock)) throw new HttpError(409, 'Pick\'em ist gesperrt — das Event hat begonnen.');
  const ids = new Set(pe.questions.map(q => q.id)), picks = {};
  for (const [k, v] of Object.entries(body.picks || {})) if (ids.has(k) && v !== '' && v !== null && v !== undefined) picks[k] = String(v).slice(0, 60);
  await env.LEAGUE.put(`evp:${slug}:${me}`, JSON.stringify(picks));
  return { picks };
}

// cron: move teams/tips of everything that has started into league.json;
// freeze a finished event in the hall of fame
export async function eventCron(env, league) {
  const evs = Object.entries(league.events || {});
  if (!evs.length) return null;
  const ids = (league.managers || []).map(m => m.id);
  const patch = {};
  for (const [slug, ev] of evs) {
    const raw = await publicData(env, `events/${slug}.json`, 120);
    if (!raw) continue;
    const d = ev.replay ? S.eventReplay(raw, ev.replay) : raw;
    const now = Date.now(), p = { stages: {}, tips: null, hall: null };
    for (const st of S.eventStages(d)) {
      if (st.lock === null || st.lock > now || (ev.revealed || []).includes(st.i)) continue;
      p.stages[st.i] = {};
      for (const id of ids) { const t = await env.LEAGUE.get(`evt:${slug}:${st.i}:${id}`, 'json'); if (t) p.stages[st.i][id] = t; }
    }
    const lock = eventPickemLock(ev, d);
    if (ev.pickem && !ev.pickem.revealed && lock && lock <= now) {
      p.tips = {};
      for (const id of ids) { const t = await env.LEAGUE.get(`evp:${slug}:${id}`, 'json'); if (t) p.tips[id] = t; }
    }
    if (S.eventDone(d) && !(league.hall || {})['event_' + slug] && Object.keys(ev.lineups || {}).length) p.hall = { d };
    if (Object.keys(p.stages).length || p.tips || p.hall) patch[slug] = p;
  }
  if (!Object.keys(patch).length) return null;
  const res = await writeLeague(env, l => {
    for (const [slug, p] of Object.entries(patch)) {
      const ev = (l.events || {})[slug];
      if (!ev) continue;
      ev.lineups = ev.lineups || {}; ev.revealed = ev.revealed || [];
      for (const [i, teams] of Object.entries(p.stages)) {
        if (ev.revealed.includes(+i)) continue;
        ev.lineups[i] = Object.assign({}, ev.lineups[i] || {}, teams);
        ev.revealed.push(+i);
      }
      if (p.tips && ev.pickem && !ev.pickem.revealed) { ev.pickem.picks = Object.assign({}, ev.pickem.picks || {}, p.tips); ev.pickem.revealed = true; ev.pickem.revealedAt = new Date().toISOString(); }
      if (p.hall && !(l.hall || {})['event_' + slug]) {
        const rows = S.eventStandings(l, ev, p.hall.d);
        l.hall = l.hall || {};
        l.hall['event_' + slug] = { event: true, slug, name: ev.name, logo: p.hall.d.logo, at: new Date().toISOString(),
          table: rows.map(r => ({ manager: r.manager, name: r.name, pts: r.total, players: r.players, pickem: r.pickem })) };
      }
    }
    return l;
  }, `events: ${Object.keys(patch).join(', ')} aufgedeckt/aktualisiert`);
  return res.changed ? Object.keys(patch) : null;
}

const youtubeId = v => {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/);
  if (!m) throw new HttpError(400, 'Das ist kein YouTube-Link.');
  return m[1];
};
// admin: create / change / delete an event, its pick'em and manual answers
export async function eventAdmin(env, body) {
  const slug = String(body.slug || '');
  if (!/^[a-z0-9_]+$/.test(slug)) throw new HttpError(400, 'Event fehlt');
  const a = body.action;
  let msg = '';
  if (a === 'create' || a === 'update' || a === 'pickem') await eventData(env, slug);     // data must exist
  const d = a === 'pickem' ? await eventData(env, slug) : null;
  const res = await writeLeague(env, l => {
    l.events = l.events || {};
    const ev = l.events[slug];
    if (a === 'create') {
      if (ev) throw new HttpError(409, 'Event gibt es schon.');
      l.events[slug] = { slug, name: String(body.name || slug).slice(0, 40), budget: 100, maxPerTeam: 2, captain: 1.5, prices: {}, video: youtubeId(body.video), createdAt: new Date().toISOString(), lineups: {}, revealed: [] };
      msg = `Event ${l.events[slug].name} angelegt`;
    } else if (!ev) throw new HttpError(404, 'Event nicht angelegt');
    else if (a === 'update') {
      if (body.name !== undefined) ev.name = String(body.name).slice(0, 40);
      if (body.budget !== undefined) { const b = Number(body.budget); if (!(b >= 50 && b <= 500)) throw new HttpError(400, 'Budget 50–500'); ev.budget = b; }
      if (body.maxPerTeam !== undefined) { const m = Number(body.maxPerTeam); if (!(m >= 1 && m <= 5)) throw new HttpError(400, 'Max. pro Team 1–5'); ev.maxPerTeam = m; }
      if (body.captain !== undefined) { const c = Number(body.captain); if (!(c >= 1 && c <= 3)) throw new HttpError(400, 'Kapitän ×1–3'); ev.captain = c; }
      if (body.video !== undefined) ev.video = youtubeId(body.video);
      if (body.videoStart !== undefined) ev.videoStart = Math.max(0, Math.floor(Number(body.videoStart) || 0));
      if (body.prices) {
        ev.prices = {};
        for (const [k, v] of Object.entries(body.prices)) { const n = Number(v); if (/^[\w.]{1,8}$/.test(k) && n >= 1 && n <= 100) ev.prices[k] = n; }
      }
      msg = `Event ${ev.name} gespeichert`;
    } else if (a === 'pickem') {
      if (ev.pickem && ev.pickem.revealed) throw new HttpError(409, 'Pick\'em ist schon aufgedeckt.');
      const qs = (body.questions || []).map((q, i) => {
        if (!S.EVENT_TYPES[q.type]) throw new HttpError(400, 'Unbekannter Fragetyp: ' + q.type);
        return { id: 'q' + (i + 1), type: q.type, points: Math.max(0, Number(q.points) || 0), label: String(q.label || '').slice(0, 80) || undefined };
      });
      if (!qs.length) throw new HttpError(400, 'Mindestens eine Frage');
      ev.pickem = Object.assign({}, ev.pickem || {}, { questions: qs, revealed: false, lockAt: body.lockAt || null });
      msg = `Pick'em für ${ev.name}: ${qs.length} Fragen`;
      void d;
    } else if (a === 'answer') {
      const q = ((ev.pickem || {}).questions || []).find(x => x.id === body.qid);
      if (!q || !(S.EVENT_TYPES[q.type] || {}).manual) throw new HttpError(400, 'Nur eigene Fragen bekommen eine Antwort');
      q.answer = body.answer ? String(body.answer) : null;
      msg = `Antwort gesetzt`;
    } else if (a === 'delete') {
      delete l.events[slug];
      msg = `Event ${slug} gelöscht`;
    } else throw new HttpError(400, 'unbekannte Aktion');
    return l;
  }, () => 'admin: ' + msg);
  if (a === 'delete') {
    for (const pre of [`evt:${slug}:`, `evp:${slug}:`]) {
      const r = await env.LEAGUE.list({ prefix: pre });
      for (const k of r.keys) await env.LEAGUE.delete(k.name);
    }
  }
  return { message: msg, league: res.league };
}
