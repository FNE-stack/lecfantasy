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

// The schedule straight from lolesports (pairings + results within a minute),
// merged over the event file that the stats job only refreshes every 2 hours.
const GW = 'https://esports-api.lolesports.com/persisted/gw/', GW_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
let leagueIds = null;
const liveCache = new Map();
async function gw(op, params) {
  const q = new URLSearchParams(Object.assign({ hl: 'en-US' }, params || {}));
  const r = await fetch(`${GW}${op}?${q}`, { headers: { 'x-api-key': GW_KEY }, cf: { cacheTtl: 30, cacheEverything: true } });
  if (!r.ok) throw new Error(op + ' ' + r.status);
  return (await r.json()).data;
}
export async function liveSchedule(leagueSlug) {
  const hit = liveCache.get(leagueSlug);
  if (hit && Date.now() - hit.at < 30000) return hit.rows;
  if (!leagueIds) leagueIds = Object.fromEntries((await gw('getLeagues')).leagues.map(l => [l.slug, l.id]));
  const id = leagueIds[leagueSlug];
  if (!id) return [];
  const first = (await gw('getSchedule', { leagueId: id })).schedule;
  let events = first.events.slice();
  for (const dir of ['newer', 'older']) {
    const tok = (first.pages || {})[dir];
    if (tok) { const s = (await gw('getSchedule', { leagueId: id, pageToken: tok })).schedule; events = dir === 'newer' ? events.concat(s.events) : s.events.concat(events); }
  }
  const rows = events.filter(e => e.type === 'match' && e.match).map(e => ({ match: e.match.id, start: e.startTime, state: e.state,
    bestOf: (e.match.strategy || {}).count || 1,
    teams: (e.match.teams || []).map(t => ({ code: t.code || 'TBD', wins: (t.result || {}).gameWins, outcome: (t.result || {}).outcome })) }));
  liveCache.set(leagueSlug, { at: Date.now(), rows });
  return rows;
}
// ev given: a test replay (ev.replay) is applied, so every check sees replay
// time; a real event that is on gets the live schedule merged in
export async function eventData(env, slug, ev) {
  if (!/^[a-z0-9_]+$/.test(String(slug || ''))) throw new HttpError(400, 'Event fehlt');
  const d = await publicData(env, `events/${slug}.json`, 120);
  if (!d) throw new HttpError(404, 'Für dieses Event gibt es noch keine Daten.');
  if (ev && ev.replay) return S.eventReplay(d, ev.replay);
  const now = Date.now();
  if (d.league && d.start && Date.parse(d.start) - 3 * 864e5 <= now && Date.parse(d.end) + 3 * 864e5 >= now) {
    try { return S.mergeLiveSchedule(d, await liveSchedule(d.league)); } catch (e) { /* the file is good enough */ }
  }
  return d;
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
  const matchTips = (await env.LEAGUE.get(`evm:${slug}:${me}`, 'json')) || {};
  return { stage, team, rounds, tips: pre.tips || {}, pickemLocked: !!pre.locked, pickemLockAt: pre.lockAt || null, matchTips };
}

// ── Tippspiel log ──────────────────────────────────────────────────────────
// Every tip change and every server step (reveal, result) is one KV key, so
// nothing is lost when people tip at the same moment. The entry sits in the
// key's metadata: the admin view reads the whole log with list calls only.
export async function tipLog(env, slug, entry) {
  const t = new Date().toISOString(), meta = Object.assign({ t }, entry);
  await env.LEAGUE.put(`evlog:${slug}:${t}:${Math.random().toString(36).slice(2, 6)}`, JSON.stringify(meta), { metadata: meta });
}
async function readTipLog(env, slug) {
  const out = [];
  let cursor;
  do {
    const r = await env.LEAGUE.list({ prefix: `evlog:${slug}:`, cursor });
    for (const k of r.keys) out.push(k.metadata || await env.LEAGUE.get(k.name, 'json'));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out.filter(Boolean).sort((a, b) => a.t.localeCompare(b.t));
}
const scoreOf = e => `${Number(e.teams[0].wins) || 0}:${Number(e.teams[1].wins) || 0}`;
// a finished series must have exactly one team on the needed wins
function oddResult(e) {
  const need = Math.ceil((e.bestOf || 1) / 2), w = e.teams.map(t => Number(t.wins) || 0);
  return Math.max(...w) !== need || Math.min(...w) >= need;
}
// Admin control view: every match with every tip and its points, the data
// sources, plausibility warnings and the log. Before kickoff the admin sees
// THAT someone tipped, not what (same rule as the pick'em) - from kickoff on all.
async function tipsAdminView(env, slug) {
  const { data: league } = await readLeague(env);
  const ev = eventOf(league, slug);
  const raw = await publicData(env, `events/${slug}.json`, 120);
  if (!raw) throw new HttpError(404, 'Für dieses Event gibt es noch keine Daten.');
  let live = null, liveErr = null;
  if (!ev.replay && raw.league) { try { live = await liveSchedule(raw.league); } catch (e) { liveErr = String(e.message || e); } }
  const d = ev.replay ? S.eventReplay(raw, ev.replay) : live && live.length ? S.mergeLiveSchedule(raw, live) : raw;
  const now = Date.now(), mgrs = league.managers || [], name = id => (mgrs.find(m => m.id === id) || {}).name || id;
  const all = {};
  for (const m of mgrs) all[m.id] = (await env.LEAGUE.get(`evm:${slug}:${m.id}`, 'json')) || {};
  const liveBy = new Map((live || []).map(x => [x.match, x])), done = new Set(ev.tipsDone || []), warnings = [];
  const label = e => `${e.teams[0].code}–${e.teams[1].code}`;
  const matches = (d.schedule || []).map(e => {
    const known = S.tipKnown(e), locked = !S.tipOpen(e, now), revealed = done.has(e.match), shown = (ev.tips || {})[e.match] || {};
    const tips = {}, pts = {};
    for (const m of mgrs) {
      const t = revealed ? shown[m.id] : all[m.id][e.match];
      if (t) tips[m.id] = locked ? S.tipOriented(e, t) : '✓';
      if (e.state === 'completed' && revealed) pts[m.id] = S.tipPoints(ev, d, e, shown[m.id]) || 0;
      // a saved tip that differs from the revealed one should never happen
      if (revealed && (all[m.id][e.match] || null) !== (shown[m.id] || null))
        warnings.push(`${label(e)}: Tipp von ${name(m.id)} gespeichert ${all[m.id][e.match] || '—'}, aufgedeckt ${shown[m.id] || '—'}`);
    }
    if (known && e.state === 'completed' && oddResult(e)) warnings.push(`${label(e)}: Ergebnis ${scoreOf(e)} passt nicht zu Bo${e.bestOf || 1}`);
    if (known && locked && !revealed && Date.parse(e.start) < now - 5 * 60e3) warnings.push(`${label(e)}: seit Spielbeginn nicht aufgedeckt (der Cron läuft jede Minute)`);
    if (live && !ev.replay && !liveBy.has(e.match)) warnings.push(`Spiel ${e.match} fehlt im Live-Spielplan`);
    return { match: e.match, start: e.start, state: e.state, stage: e.stage, bestOf: e.bestOf || 1, teams: e.teams, known, locked, revealed, tips, pts,
      src: ev.replay ? 'replay' : liveBy.has(e.match) ? 'live' : 'datei' };
  });
  // the stats job is the safety net (games for bingo/pick'em, pairings if the
  // live schedule fails) - a step that dies silently must show up here
  const age = raw.updated ? (now - raw.updated * 1000) / 36e5 : null;
  if (!ev.replay && age !== null && age > 3 && Date.parse(raw.start) <= now && Date.parse(raw.end) + 864e5 >= now)
    warnings.unshift(`Event-Datei seit ${Math.round(age)} h nicht aktualisiert — der Stats-Job (alle 2 h) schreibt sie nicht. GitHub → Actions → update-stats → Schritt „Fetch special events" prüfen.`);
  const log = await readTipLog(env, slug);
  const open = new Set(matches.filter(m => !m.locked).map(m => m.match)), byMatch = new Map((d.schedule || []).map(e => [e.match, e]));
  for (const x of log) {
    if (x.k !== 'tip' && x.k !== 'anchor') continue;
    if (open.has(x.x)) { if (x.s) x.s = '✓'; if (x.o) x.o = '✓'; continue; }
    const e = byMatch.get(x.x);
    if (e && x.s) x.s = S.tipOriented(e, x.s);
    if (e && x.o) x.o = S.tipOriented(e, x.o);
  }
  return { now, replay: !!ev.replay, source: { file: raw.updated ? raw.updated * 1000 : null, live: live ? live.length : null, liveErr },
    stages: (d.stages || []).map(s => s.name), matches, totals: S.eventTipTotals(league, ev, d), warnings, log: log.slice(-2000) };
}
// cron: one log entry per finished match (with everybody's points), again if
// the result changes afterwards. evres:<slug> remembers what was logged.
async function logResults(env, slug, ev, d) {
  const key = `evres:${slug}`, seen = (await env.LEAGUE.get(key, 'json')) || {};
  let changed = false;
  for (const e of d.schedule || []) {
    if (e.state !== 'completed' || !S.tipKnown(e) || !(ev.tipsDone || []).includes(e.match)) continue;
    const r = scoreOf(e);
    if (seen[e.match] === r) continue;
    const pts = {};
    for (const [mid, t] of Object.entries((ev.tips || {})[e.match] || {})) pts[mid] = S.tipPoints(ev, d, e, t) || 0;
    await tipLog(env, slug, { k: 'result', x: e.match, r, o: seen[e.match] || null, pts, odd: oddResult(e) || undefined });
    seen[e.match] = r; changed = true;
  }
  if (changed) await env.LEAGUE.put(key, JSON.stringify(seen));
}

// one match tip: { slug, match, score: "a:b" | null }. Only while the match is
// open (both teams known, not started); secret until the match starts.
export async function eventSaveTip(env, me, body) {
  const slug = String(body.slug || '');
  const { data: league } = await readLeague(env);
  const ev = eventOf(league, slug);
  if (!S.eventTipsOn(ev)) throw new HttpError(409, 'Bei diesem Event gibt es kein Tippspiel.');
  const d = await eventData(env, slug, ev);
  const e = (d.schedule || []).find(x => x.match === String(body.match || ''));
  if (!e) throw new HttpError(404, 'Unbekanntes Spiel.');
  if (!S.tipKnown(e)) throw new HttpError(409, 'Die Paarung steht noch nicht fest.');
  if (!S.tipOpen(e)) throw new HttpError(409, 'Das Spiel hat schon begonnen — Tipp gesperrt.');
  const raw = body.score === null || body.score === '' ? null : String(body.score).split('@')[0];
  if (raw !== null && !S.tipValid(e.bestOf, raw)) throw new HttpError(400, `Kein gültiges Ergebnis für Bo${e.bestOf || 1}.`);
  // the order the player SAW: the page sends the first team's code
  const codes = e.teams.map(t => t.code), first = codes.includes(body.first) ? body.first : codes[0];
  const score = raw === null ? null : `${raw}@${first}`;
  const key = `evm:${slug}:${me}`, mine = (await env.LEAGUE.get(key, 'json')) || {}, old = mine[e.match] || null;
  if (score === null) delete mine[e.match]; else mine[e.match] = score;
  await env.LEAGUE.put(key, JSON.stringify(mine));
  if (old !== score) await tipLog(env, slug, { k: 'tip', m: me, x: e.match, s: score, o: old });
  return { match: e.match, score };
}

export async function eventSaveTeam(env, me, body) {
  const slug = String(body.slug || '');
  const { data: league } = await readLeagueFresh(env);
  const ev = eventOf(league, slug), d = await eventData(env, slug, ev);
  if (!S.eventSquadOn(ev)) throw new HttpError(409, 'Bei diesem Event gibt es kein Team — nur Pick\'em und Minispiel.');
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

// Monopoly: a manager's pilot / buy rule. Stored with the time; a choice only
// counts for games that start after it, so nothing can be picked in hindsight.
export async function eventSaveMono(env, me, body) {
  const slug = String(body.slug || '');
  const { data: league } = await readLeagueFresh(env);
  const ev = eventOf(league, slug), d = await eventData(env, slug, ev);
  if (S.eventMinigame(ev) !== 'monopoly') throw new HttpError(409, 'Bei diesem Event läuft kein Monopoly.');
  const c = { at: new Date().toISOString() };
  if (ev.replay) c.orig = Math.round(ev.replay.first + (Date.now() - ev.replay.from) * ev.replay.speed);
  if (body.pilot !== undefined) { if (!S.eventPlayer(d, String(body.pilot))) throw new HttpError(400, 'Spieler spielt bei diesem Event nicht.'); c.pilot = String(body.pilot); }
  if (body.rule !== undefined) { if (!['all', 'top', 'lec', 'none'].includes(body.rule)) throw new HttpError(400, 'Unbekannte Kauf-Regel'); c.rule = body.rule; }
  if (!c.pilot && !c.rule) throw new HttpError(400, 'Nichts zu speichern');
  await writeLeague(env, l => {
    const e = l.events[slug]; e.mono = e.mono || {}; e.mono.choices = e.mono.choices || {};
    e.mono.choices[me] = (e.mono.choices[me] || []).concat(c).slice(-200);
    return l;
  }, `monopoly: ${slug} ${c.pilot ? 'Pilot' : 'Kauf-Regel'}`);
  return { ok: true, choice: c };
}

// Admin overview: WHO has tipped, and how far - never WHAT they tipped.
// Counting the answered questions is enough to chase people before the lock,
// and reading the picks would break the same secrecy promise the players get
// ("niemand sieht deine Tipps vorher") for the admin too. So this returns
// counts only, deliberately.
export async function tipStatus(env, league) {
  const out = {};
  const evs = (league && league.events) || {};
  for (const [slug, ev] of Object.entries(evs)) {
    const rounds = {};
    for (const [round, key] of [['pre', 'pickem'], ['ko', 'pickemKo']]) {
      const pe = ev[key];
      if (!pe || !(pe.questions || []).length) continue;
      const total = pe.questions.length;
      const per = {};
      for (const m of (league.managers || [])) {
        let n = 0;
        if (pe.revealed) {
          n = Object.keys((pe.picks || {})[m.id] || {}).length;
        } else {
          const t = await env.LEAGUE.get(tipKey(slug, round, m.id), 'json').catch(() => null);
          n = t ? Object.keys(t).length : 0;
        }
        per[m.id] = n;
      }
      rounds[round] = { total, revealed: !!pe.revealed, answered: per };
    }
    if (Object.keys(rounds).length) out[slug] = rounds;
  }
  return out;
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
    const d = await eventData(env, slug, ev).catch(() => (ev.replay ? S.eventReplay(raw, ev.replay) : raw));
    const now = Date.now(), p = { stages: {}, tips: null, hall: null, matchTips: null };
    if (S.eventTipsOn(ev)) {
      const done = new Set(ev.tipsDone || []);
      const started = (d.schedule || []).filter(e => !done.has(e.match) && S.tipKnown(e) && (e.state !== 'unstarted' || Date.parse(e.start) <= now));
      if (started.length) {
        const all = {};
        for (const id of ids) all[id] = (await env.LEAGUE.get(`evm:${slug}:${id}`, 'json')) || {};
        p.matchTips = {};
        for (const e of started) {
          p.matchTips[e.match] = {};
          for (const id of ids) if (all[id][e.match]) p.matchTips[e.match][id] = all[id][e.match];
        }
      }
    }
    for (const st of S.eventSquadOn(ev) ? S.eventStages(d) : []) {
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
    // hall of fame once it is over - and only if anybody actually played it
    const played = Object.keys(ev.lineups || {}).length || Object.keys(ev.tips || {}).length || (ev.pickem && ev.pickem.revealed && Object.keys(ev.pickem.picks || {}).length) || S.eventMinigame(ev) === 'bingo';
    if (S.eventDone(d) && !(league.hall || {})['event_' + slug] && played && (league.managers || []).length) p.hall = { d };
    if (S.eventTipsOn(ev)) await logResults(env, slug, ev, d).catch(() => null);
    if (Object.keys(p.stages).length || p.tips || p.hall || p.matchTips) patch[slug] = p;
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
      if (p.matchTips) {
        ev.tips = ev.tips || {}; ev.tipsDone = ev.tipsDone || [];
        for (const [m, t] of Object.entries(p.matchTips)) {
          if (ev.tipsDone.includes(m)) continue;
          ev.tips[m] = Object.assign({}, ev.tips[m] || {}, t);
          ev.tipsDone.push(m);
        }
      }
      for (const [key, tips] of Object.entries(p.tips || {})) {
        const pe = ev[key];
        if (pe && !pe.revealed) { pe.picks = Object.assign({}, pe.picks || {}, tips); pe.revealed = true; pe.revealedAt = new Date().toISOString(); }
      }
      if (p.hall && !(l.hall || {})['event_' + slug]) {
        const rows = S.eventStandings(l, ev, p.hall.d);
        l.hall = l.hall || {};
        l.hall['event_' + slug] = { event: true, slug, name: ev.name, logo: p.hall.d.logo, at: new Date().toISOString(),
          table: rows.map(r => ({ manager: r.manager, name: r.name, pts: r.total, tips: r.tips, players: r.players, pickem: r.pickem })) };
      }
    }
    return l;
  }, `events: ${Object.keys(patch).join(', ')} aufgedeckt/aktualisiert`);
  if (res.changed) {
    for (const [slug, p] of Object.entries(patch)) for (const [m, t] of Object.entries(p.matchTips || {}))
      await tipLog(env, slug, { k: 'reveal', x: m, n: Object.keys(t).length }).catch(() => null);
  }
  return res.changed ? Object.keys(patch) : null;
}

// a new bingo line on someone's card: push to that manager (once per line).
// Only OPEN rounds - a closed round cannot change. KV bingo:<slug>:<run seed>
// = { [manager]: lines seen } - one read per open round.
async function bingoNotices(env, league) {
  for (const [slug, ev] of Object.entries(league.events || {})) {
    if (S.eventMinigame(ev) !== 'bingo') continue;
    const raw = await publicData(env, `events/${slug}.json`, 120);
    if (!raw) continue;
    const d = ev.replay ? S.eventReplay(raw, ev.replay) : raw;
    const runs = S.eventBingoRuns(ev, d), many = runs.length > 1;
    for (const run of runs.filter(r => !r.closed)) {
      const all = S.eventBingoAll(league, ev, d, run);
      const key = `bingo:${slug}:${run.seed || ''}`;
      let seen = {};
      try { const v = JSON.parse((await env.LEAGUE.get(key)) || '{}'); if (v && typeof v === 'object') seen = v; } catch (e) { /* old format: a number */ }
      let changed = false;
      for (const [mid, b] of Object.entries(all)) {
        const lines = b.score.lines, was = Number(seen[mid]) || 0;
        if (lines === was) continue;
        seen[mid] = lines; changed = true;
        if (lines < was) continue;
        // the square that finished it: the newest hit inside a finished line
        const inLine = new Set(b.score.lineCells.flat());
        const last = b.card.cells.filter((k, i) => inLine.has(i) && b.hits[k].hit).sort((x, y) => String(b.hits[y].at).localeCompare(String(b.hits[x].at)))[0];
        const sq = S.BINGO[last] || {};
        await notify(env, [mid], { title: b.score.full ? '🎉 VOLLE BINGO-KARTE!' : '🎉 BINGO!',
          body: `${ev.name}${many ? ' · ' + run.name : ''}: ${lines === 1 ? 'deine erste Linie' : 'deine ' + lines + '. Linie'} — +${b.score.full ? b.cfg.full : b.cfg.line} Punkte.${sq.label ? ' Letztes Feld: ' + sq.label + '.' : ''}`,
          url: `./#/event/${slug}`, tag: 'bingo-' + slug }).catch(() => null);
      }
      if (changed) await env.LEAGUE.put(key, JSON.stringify(seen));
    }
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
  if (a === 'tipsLog') return { view: await tipsAdminView(env, slug) };
  if (a === 'tipsAnchor') {
    // tips saved before "@CODE" existed: body.first = { match: code that was
    // first when they were made }; every other match: its current order
    const { data: league } = await readLeague(env);
    const ev = eventOf(league, slug), d = await eventData(env, slug, ev);
    const byMatch = new Map((d.schedule || []).map(e => [e.match, e])), given = body.first || {};
    const anchor = (m, t) => {
      if (!t || String(t).includes('@')) return t;
      const e = byMatch.get(m), code = given[m] || (e && S.tipKnown(e) ? e.teams[0].code : null);
      return code ? `${t}@${code}` : t;
    };
    let n = 0;
    for (const mg of league.managers || []) {
      const key = `evm:${slug}:${mg.id}`, mine = (await env.LEAGUE.get(key, 'json')) || {};
      let ch = false;
      for (const [m, t] of Object.entries(mine)) { const v = anchor(m, t); if (v !== t) { mine[m] = v; ch = true; n++; await tipLog(env, slug, { k: 'anchor', m: mg.id, x: m, s: v, o: t }); } }
      if (ch) await env.LEAGUE.put(key, JSON.stringify(mine));
    }
    await writeLeague(env, l => {
      const v = l.events[slug];
      for (const [m, tips] of Object.entries(v.tips || {})) for (const [mid, t] of Object.entries(tips)) tips[mid] = anchor(m, t);
      return l;
    }, `admin: Tipps mit Teamreihenfolge versehen (${slug})`);
    return { message: `${n} Tipps verankert` };
  }
  if (a === 'setTip') {
    // admin correction (e.g. a tip that came in by message): any match with
    // known teams, even after kickoff; logged as "Admin"
    const { data: league } = await readLeague(env);
    const ev = eventOf(league, slug), d = await eventData(env, slug, ev);
    const e = (d.schedule || []).find(x => x.match === String(body.match || ''));
    if (!e) throw new HttpError(404, 'Unbekanntes Spiel.');
    if (!S.tipKnown(e)) throw new HttpError(409, 'Die Paarung steht noch nicht fest.');
    const mgr = String(body.manager || '');
    if (!(league.managers || []).some(m => m.id === mgr)) throw new HttpError(404, 'Unbekannter Manager.');
    const raw = body.score === null || body.score === '' ? null : String(body.score).trim();
    if (raw !== null && !S.tipValid(e.bestOf, raw)) throw new HttpError(400, `Kein gültiges Ergebnis für Bo${e.bestOf || 1} (z. B. ${S.tipScores(e.bestOf).join(', ')}).`);
    const score = raw === null ? null : `${raw}@${e.teams[0].code}`;
    const key = `evm:${slug}:${mgr}`, mine = (await env.LEAGUE.get(key, 'json')) || {}, old = mine[e.match] || null;
    if (score === null) delete mine[e.match]; else mine[e.match] = score;
    await env.LEAGUE.put(key, JSON.stringify(mine));
    if ((ev.tipsDone || []).includes(e.match)) {
      await writeLeague(env, l => {
        const v = l.events[slug];
        v.tips = v.tips || {}; v.tips[e.match] = Object.assign({}, v.tips[e.match] || {});
        if (score === null) delete v.tips[e.match][mgr]; else v.tips[e.match][mgr] = score;
        return l;
      }, `admin: Tipp korrigiert (${slug})`);
    }
    await tipLog(env, slug, { k: 'tip', m: mgr, x: e.match, s: score, o: old, by: 'admin' });
    return { message: `Tipp ${score === null ? 'gelöscht' : 'gesetzt: ' + score} (${e.teams[0].code}–${e.teams[1].code})` };
  }
  let msg = '';
  if (a === 'create' || a === 'update' || a === 'pickem') await eventData(env, slug);     // data must exist
  // the round catalog and a new bingo run both need the event's stage list
  const d = (a === 'pickem' || (a === 'update' && body.bingoNewRun)) ? await eventData(env, slug) : null;
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
      // Start a NEW bingo board from a stage onwards, keeping the finished one.
      // Reshuffling alone would wipe the Play-Ins result; here the old run is
      // closed (its points stay) and a fresh board covers the stages from
      // `fromStage` on, so it cannot open half-ticked from games already played.
      if (body.bingoNewRun) {
        const stages = (d.stages || []).map((st, i) => i);
        const from = Math.max(0, Math.min(stages.length - 1, Number(body.fromStage) || 0));
        if (!stages.length) throw new HttpError(400, 'Event hat keine Phasen');
        const runs = Array.isArray(ev.bingoRuns) && ev.bingoRuns.length ? ev.bingoRuns.slice() : null;
        const name = i => (d.stages[i] || {}).name || ('Phase ' + (i + 1));
        if (!runs) {
          // first split: everything before `from` becomes the closed run
          const before = stages.filter(i => i < from);
          if (!before.length) throw new HttpError(400, 'Vor dieser Phase liegt nichts, was abgeschlossen werden könnte');
          ev.bingoRuns = [
            { id: 'r1', name: before.map(name).join(' + '), seed: ev.bingoSeed || 'r1', stages: before, closed: true },
            { id: 'r2', name: stages.filter(i => i >= from).map(name).join(' + '),
              seed: Math.random().toString(36).slice(2, 8), stages: stages.filter(i => i >= from), closed: false, cardV: 2 },
          ];
        } else {
          const open = runs[runs.length - 1];
          const keep = (open.stages || stages).filter(i => i < from);
          const next = (open.stages || stages).filter(i => i >= from);
          if (!next.length) throw new HttpError(400, 'Ab dieser Phase ist nichts mehr übrig');
          if (keep.length) { open.stages = keep; open.name = keep.map(name).join(' + '); }
          open.closed = true;
          if (!keep.length) runs.pop();
          runs.push({ id: 'r' + (runs.length + 1), name: next.map(name).join(' + '),
            seed: Math.random().toString(36).slice(2, 8), stages: next, closed: false, cardV: 2 });
          ev.bingoRuns = runs;
        }
        msg = `Neue Bingo-Karten ab „${name(from)}" — die abgeschlossene Runde behält ihre Punkte`;
      }
      if (body.bingoCardV) {
        const r = (ev.bingoRuns || []).find(x => x.id === body.bingoCardV.run);
        if (!r) throw new HttpError(404, 'Bingo-Runde unbekannt');
        if (r.closed) throw new HttpError(409, 'Eine abgeschlossene Runde bleibt, wie sie ist');
        r.cardV = Math.max(1, Math.min(2, Number(body.bingoCardV.v) || 2));
        msg = `Bingo-Runde ${r.name}: Kartenversion ${r.cardV}`;
      }
      if (body.squad !== undefined) ev.squad = !!body.squad;
      if (body.minigame !== undefined) { if (!['bingo', 'monopoly', 'none'].includes(body.minigame)) throw new HttpError(400, 'Minispiel: bingo, monopoly oder none'); ev.minigame = body.minigame; }
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
        if (!S.EVENT_TYPES[q.type].manual && !S.eventPickemCatalog(d, body.round === 'ko' ? 'ko' : 'pre').includes(q.type)) throw new HttpError(400, `„${S.EVENT_TYPES[q.type].label}" gehört nicht in diese Runde.`);
        const other = ev[body.round === 'ko' ? 'pickem' : 'pickemKo'];
        if (!S.EVENT_TYPES[q.type].manual && other && (other.questions || []).some(x => x.type === q.type)) throw new HttpError(400, `„${S.EVENT_TYPES[q.type].label}" steht schon in der anderen Runde.`);
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
    await env.LEAGUE.delete(`evres:${slug}`);
    for (const pre of [`evt:${slug}:`, `evp:${slug}:`, `evm:${slug}:`, `evlog:${slug}:`]) {
      const r = await env.LEAGUE.list({ prefix: pre });
      for (const k of r.keys) await env.LEAGUE.delete(k.name);
    }
  }
  return { message: msg, league: res.league };
}
