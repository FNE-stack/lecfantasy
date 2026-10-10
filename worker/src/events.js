// ═══════════════════════════════════════════════════════════════════════════
// Special events (First Stand, MSI, Worlds): budget teams + pick'em.
//
// Like the split pick'em, nothing a member saves is visible to the others
// before the lock: a stage's team waits in KV (`evt:<slug>:<stage>:<id>`), the
// event pick'em in `evp:<slug>:<id>` (round before the knockouts:
// `evp:<slug>:ko:<id>`). The cron moves them into league.json once
// the stage (or the pick'em) has started. Rules: scoring.js (event*).
// ═══════════════════════════════════════════════════════════════════════════
import { S, HttpError, readLeague, readLeagueFresh, writeLeague, publicData, writeSiteFile } from './store.js';
import { notify } from './push.js';

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
// two pick'em rounds: 'pre' (ev.pickem, locks at the first match) and 'ko'
// (ev.pickemKo, locks at the first knockout match)
const ROUNDS = { pre: 'pickem', ko: 'pickemKo' };
const tipKey = (slug, round, id) => round === 'ko' ? `evp:${slug}:ko:${id}` : `evp:${slug}:${id}`;
export function eventPickemLock(ev, evData, round) {
  const pe = ev[ROUNDS[round || 'pre']] || {};
  if (pe.lockAt) return Date.parse(pe.lockAt);
  const st = S.eventStages(evData);
  const s = round === 'ko' ? st[st.length - 1] : st.find(x => x.lock !== null);
  return s && s.lock !== null ? s.lock : null;
}

// my (secret) team for the open stage + my tips
export async function eventState(env, me, slug) {
  const { data: league } = await readLeague(env);
  const ev = eventOf(league, slug), d = await eventData(env, slug, ev);
  const stage = S.eventOpenStage(d);
  let team = stage === null ? null : await env.LEAGUE.get(`evt:${slug}:${stage}:${me}`, 'json');
  if (!team && stage !== null) team = S.eventLineup(ev, me, stage - 1);    // carried over from the last stage
  const rounds = {};
  for (const [round, key] of Object.entries(ROUNDS)) {
    const pe = ev[key];
    if (!pe) continue;
    const lock = eventPickemLock(ev, d, round);
    rounds[round] = { tips: pe.revealed ? ((pe.picks || {})[me] || {}) : ((await env.LEAGUE.get(tipKey(slug, round, me), 'json')) || {}),
                      locked: !!(pe.revealed || (lock && Date.now() >= lock)), lockAt: lock ? new Date(lock).toISOString() : null };
  }
  // older pages read tips/pickemLocked/pickemLockAt
  const pre = rounds.pre || {};
  return { stage, team, rounds, tips: pre.tips || {}, pickemLocked: !!pre.locked, pickemLockAt: pre.lockAt || null };
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
  const round = body.round === 'ko' ? 'ko' : 'pre';
  const pe = ev[ROUNDS[round]];
  if (!pe || !(pe.questions || []).length) throw new HttpError(404, 'Für dieses Event ist noch kein Pick\'em offen.');
  const lock = eventPickemLock(ev, d, round);
  if (pe.revealed || (lock && Date.now() >= lock)) throw new HttpError(409, round === 'ko' ? 'Pick\'em ist gesperrt — die K.-o.-Phase hat begonnen.' : 'Pick\'em ist gesperrt — das Event hat begonnen.');
  const qs = new Map(pe.questions.map(q => [q.id, q])), picks = {};
  for (const [k, v] of Object.entries(body.picks || {})) {
    const q = qs.get(k);
    if (!q || v === '' || v === null || v === undefined) continue;
    const def = S.EVENT_TYPES[q.type] || {};
    // several picks: distinct, at most `count`
    picks[k] = def.count ? [...new Set(String(v).split(',').map(x => x.trim()).filter(Boolean))].slice(0, def.count).join(',').slice(0, 200) : String(v).slice(0, 60);
  }
  await env.LEAGUE.put(tipKey(slug, round, me), JSON.stringify(picks));
  return { picks, round };
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
    for (const [round, key] of Object.entries(ROUNDS)) {
      const lock = eventPickemLock(ev, d, round);
      if (ev[key] && !ev[key].revealed && lock && lock <= now) {
        const tips = {};
        for (const id of ids) { const t = await env.LEAGUE.get(tipKey(slug, round, id), 'json'); if (t) tips[id] = t; }
        (p.tips = p.tips || {})[key] = tips;
      }
    }
    if (S.eventDone(d) && !(league.hall || {})['event_' + slug] && Object.keys(ev.lineups || {}).length) p.hall = { d };
    if (Object.keys(p.stages).length || p.tips || p.hall) patch[slug] = p;
  }
  await bingoNotices(env, league).catch(() => null);
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
      for (const [key, tips] of Object.entries(p.tips || {})) {
        const pe = ev[key];
        if (pe && !pe.revealed) { pe.picks = Object.assign({}, pe.picks || {}, tips); pe.revealed = true; pe.revealedAt = new Date().toISOString(); }
      }
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

// a new bingo line: push to everyone (once per line, KV bingo:<slug> = lines seen)
async function bingoNotices(env, league) {
  const ids = (league.managers || []).map(m => m.id);
  for (const [slug, ev] of Object.entries(league.events || {})) {
    const raw = await publicData(env, `events/${slug}.json`, 120);
    if (!raw) continue;
    const d = ev.replay ? S.eventReplay(raw, ev.replay) : raw;
    const b = S.eventBingo(league, ev, d), lines = b.score.lines;
    const key = `bingo:${slug}:${ev.bingoSeed || ''}`, seen = Number(await env.LEAGUE.get(key)) || 0;
    if (lines <= seen) { if (lines < seen) await env.LEAGUE.put(key, String(lines)); continue; }
    await env.LEAGUE.put(key, String(lines));
    // the square that finished it: the newest hit inside a finished line
    const inLine = new Set(b.score.lineCells.flat());
    const last = b.card.cells.filter((k, i) => inLine.has(i) && b.hits[k].hit).sort((x, y) => String(b.hits[y].at).localeCompare(String(b.hits[x].at)))[0];
    const sq = S.BINGO[last] || {};
    await notify(env, ids, { title: b.score.full ? '🎉 VOLLE BINGO-KARTE!' : '🎉 BINGO!',
      body: `${ev.name}: ${lines === 1 ? 'erste Linie' : lines + '. Linie'} — alle bekommen +${b.score.full ? b.cfg.full : b.cfg.line} Punkte.${sq.label ? ' Letztes Feld: ' + sq.label + '.' : ''}`,
      url: `./#/event/${slug}`, tag: 'bingo-' + slug }).catch(() => null);
  }
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
  if (a === 'teams') {
    // participants Riot has not put into the schedule yet; the stats job picks them up
    const codes = [...new Set(String(body.teams || '').toUpperCase().split(/[\s,;]+/).filter(c => /^[A-Z0-9]{1,6}$/.test(c)))];
    await writeSiteFile(env, 'data/config.json', cur => {
      const c = Object.assign({}, cur || {});
      c.eventTeams = Object.assign({}, c.eventTeams || {});
      if (codes.length) c.eventTeams[slug] = codes; else delete c.eventTeams[slug];
      return c;
    }, `config: Teilnehmer ${slug} (${codes.length})`);
    return { message: `Teilnehmer gespeichert (${codes.length} Teams) — sie erscheinen mit dem nächsten Stats-Update (spätestens in 2 Stunden).` };
  }
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
      if (body.reshuffle) ev.bingoSeed = Math.random().toString(36).slice(2, 8);
      if (body.prices) {
        ev.prices = {};
        for (const [k, v] of Object.entries(body.prices)) { const n = Number(v); if (/^[\w.]{1,8}$/.test(k) && n >= 1 && n <= 100) ev.prices[k] = n; }
      }
      msg = `Event ${ev.name} gespeichert`;
    } else if (a === 'pickem') {
      const key = body.round === 'ko' ? 'pickemKo' : 'pickem';
      if (ev[key] && ev[key].revealed) throw new HttpError(409, 'Pick\'em ist schon aufgedeckt.');
      const qs = (body.questions || []).map((q, i) => {
        if (!S.EVENT_TYPES[q.type]) throw new HttpError(400, 'Unbekannter Fragetyp: ' + q.type);
        return { id: 'q' + (i + 1), type: q.type, points: Math.max(0, Number(q.points) || 0), label: String(q.label || '').slice(0, 80) || undefined };
      });
      if (!qs.length) throw new HttpError(400, 'Mindestens eine Frage');
      ev[key] = Object.assign({}, ev[key] || {}, { questions: qs, revealed: false, lockAt: body.lockAt || null });
      msg = `Pick'em ${body.round === 'ko' ? '(K.-o.-Runde) ' : ''}für ${ev.name}: ${qs.length} Fragen`;
      void d;
    } else if (a === 'answer') {
      const q = ((ev[body.round === 'ko' ? 'pickemKo' : 'pickem'] || {}).questions || []).find(x => x.id === body.qid);
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
