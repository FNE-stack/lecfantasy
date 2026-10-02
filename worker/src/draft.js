// ═══════════════════════════════════════════════════════════════════════════
// draft.js — joining, picking, the pick timer and trades.
//
// One pick path (makePick) for members, the admin and the auto-pick, so all
// three obey exactly the same rules. Every decision is made inside
// writeLeague's mutate callback, i.e. re-checked on the freshest league on
// every retry - two simultaneous picks can never both pass.
// ═══════════════════════════════════════════════════════════════════════════
import { S, HttpError, writeLeague, readLeagueFresh, playerIndex, seasonPoints, cfg } from './store.js';
import { randomHex } from './auth.js';

export const nameKey = n => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
export function cleanName(n) {
  const s = String(n || '').trim().replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 24) throw new HttpError(400, 'Name: 2–24 Zeichen');
  if (/[<>"]/.test(s)) throw new HttpError(400, 'Name enthält ungültige Zeichen');
  if (s.toLowerCase() === 'admin') throw new HttpError(400, 'Der Name „admin" ist reserviert.');
  return s;
}
export const mgrName = (league, id) => ((league.managers || []).find(m => m.id === id) || {}).name || id;

// ── join ──────────────────────────────────────────────────────────────────
export async function addMember(env, name, opts) {
  opts = opts || {};
  const clean = cleanName(name);
  const players = await playerIndex(env);
  let newId = null;
  await writeLeague(env, league => {
    const st = S.draftStatus(league);
    if (st !== 'lobby' && !opts.admin) throw new HttpError(409, 'Die Anmeldung ist geschlossen — der Draft hat schon begonnen. Frag den Admin.');
    if ((league.managers || []).some(m => nameKey(m.name) === nameKey(clean))) throw new HttpError(409, 'Den Namen gibt es schon — nimm einen anderen.');
    const cap = S.capacity(league, players);
    if ((league.managers || []).length >= cap && !opts.force) throw new HttpError(409, `Die Liga ist voll — der Spielerpool reicht für ${cap} Manager.`);
    newId = 'm' + randomHex(4);
    league.managers = (league.managers || []).concat({ id: newId, name: clean, joined: new Date().toISOString() });
    // late additions by the admin go to the end of the order
    league.draft.order = (league.draft.order || []).concat(newId);
    return league;
  }, `${opts.admin ? 'admin' : 'join'}: ${clean} ist dabei`);
  return { id: newId, name: clean };
}

// ── picking ───────────────────────────────────────────────────────────────
// opts.by: 'member' | 'admin' | 'auto'   opts.force: admin ignores turn + rules
export async function makePick(env, manager, playerId, opts) {
  opts = opts || {};
  const players = await playerIndex(env);
  const meta = players.get(playerId);
  let picked = null;
  const res = await writeLeague(env, league => {
    const st = S.draftStatus(league);
    if (st !== 'live' && !opts.force) throw new HttpError(409, st === 'lobby' ? 'Der Draft hat noch nicht begonnen.' : 'Der Draft ist abgeschlossen.');
    const turn = S.currentPicker(league);
    const who = manager || turn;
    if (!who) throw new HttpError(409, 'Niemand ist am Zug.');
    if (opts.expectTurn && turn !== opts.expectTurn) return null;   // auto-pick raced a real pick
    if (who !== turn && !opts.force) throw new HttpError(409, `Nicht dein Zug — ${mgrName(league, turn)} ist dran.`);
    if (!opts.force) {
      const why = S.pickError(league, players, who, playerId);
      if (why) throw new HttpError(422, why);
    } else if (S.ownership(league).has(playerId)) {
      throw new HttpError(422, 'Spieler ist schon vergeben — erst den anderen Pick ändern.');
    }
    league.draft.picks.push(Object.assign({ manager: who, player: playerId, at: new Date().toISOString() },
      opts.by && opts.by !== 'member' ? { by: opts.by } : {}));
    if (S.currentPicker(league) === null && league.draft.picks.length >= league.draft.order.length * S.rosterSize(league)) {
      league.draft.status = 'done'; league.draft.completed = true;
    }
    picked = who;
    return league;
  }, l => `draft: ${mgrName(l, picked)} pickt ${meta ? meta.name : playerId}`
        + `${meta ? ` (${meta.team} ${meta.role})` : ''}${opts.by === 'admin' ? ' [admin]' : opts.by === 'auto' ? ' [auto]' : ''}`);
  return { league: res.league, picked: playerId, manager: picked, changed: res.changed };
}

// ── pick timer (backbone; mode defaults to 'off') ────────────────────────
//   draft.timer = { mode: 'off' | 'soft' | 'auto', seconds: 90 }
// soft: the page shows a countdown, nothing happens. auto: when it runs out,
// the next state poll picks for the manager - first legal player from their
// queue (KV queue:<id>), else the best available by last split's points.
export function deadline(league) {
  const t = (league.draft && league.draft.timer) || {};
  if (!t.mode || t.mode === 'off' || !t.seconds || S.draftStatus(league) !== 'live') return null;
  const picks = league.draft.picks || [];
  const since = picks.length ? picks[picks.length - 1].at : league.draft.startedAt;
  if (!since) return null;
  return new Date(new Date(since).getTime() + t.seconds * 1000).toISOString();
}
export async function autoPickIfDue(env, league) {
  const t = (league.draft && league.draft.timer) || {};
  const due = deadline(league);
  if (t.mode !== 'auto' || !due || Date.now() < new Date(due).getTime()) return null;
  const turn = S.currentPicker(league);
  if (!turn) return null;
  const players = await playerIndex(env);
  const queue = (await env.LEAGUE.get(`queue:${turn}`, 'json')) || [];
  const level = S.relaxLevel(league, players, turn);
  let choice = queue.find(id => players.has(id) && !S.pickError(league, players, turn, id, level));
  if (!choice) {
    const pts = await seasonPoints(env, league);
    choice = [...players.keys()].filter(id => !S.pickError(league, players, turn, id, level))
      .sort((a, b) => (pts.get(b) || 0) - (pts.get(a) || 0))[0];
  }
  if (!choice) return null;
  try { return await makePick(env, turn, choice, { by: 'auto', expectTurn: turn }); }
  catch (e) { return null; }   // someone picked meanwhile - fine
}

// ── transfers: trades between managers + free-agent pickups ──────────────
// Rules live in league.tradeRules (see scoring.js transferRules). Every check
// runs inside writeLeague, i.e. against the freshest league on every retry.
//   league.trades[] = { id, from, to, give[], get[], status, at, decidedAt }
//     status: proposed -> accepted | rejected | cancelled | vetoed
//             (adminApproval: proposed -> agreed -> accepted by the admin)
//   free-agent pickup = league.swaps[] entry { manager, out, in, at, by:'self' }
function windowGuard(league, rules) {
  if (S.draftStatus(league) !== 'done') throw new HttpError(409, 'Transfers gibt es erst nach dem Draft.');
  const w = S.transferWindow(league, new Date().toISOString());
  if (!w.open) {
    throw new HttpError(409, w.next
      ? `Das Transferfenster ist zu — das nächste öffnet am ${new Date(w.next.from).toLocaleDateString('de-DE')}.`
      : 'Das Transferfenster ist zu.');
  }
}
// Only blocks problems a transfer CREATES: a roster that was already off
// (an emergency pick in the draft) must still be able to trade its way back.
function rosterGuard(league, players, rules, rostersAfter) {
  const opts = { roles: !!rules.rosterRules, teams: !!rules.teamLimit };
  if (!opts.roles && !opts.teams) return;
  const now = S.rosters(league);
  for (const [mgr, ids] of Object.entries(rostersAfter)) {
    const before = new Set(S.rosterProblems(league, players, now[mgr] || [], opts));
    const added = S.rosterProblems(league, players, ids, opts).filter(x => !before.has(x));
    if (added.length) throw new HttpError(422, `Danach hätte ${mgrName(league, mgr)}: ${added.join(', ')}.`);
  }
}

export async function tradeAction(env, me, body) {
  const action = body.action;
  const players = await playerIndex(env);
  if (['claim', 'unclaim', 'claimMove'].includes(action)) return claimAction(env, me, body, players);
  let out = null;
  await writeLeague(env, league => {
    const rules = S.transferRules(league);
    league.trades = league.trades || [];
    league.swaps = league.swaps || [];
    const ros = S.rosters(league);
    const now = new Date().toISOString();

    if (action === 'freeAgent') {
      if (!rules.freeAgents) throw new HttpError(403, 'Free Agents sind in dieser Liga nicht erlaubt.');
      if (rules.faMode === 'waiver') throw new HttpError(409, 'Free Agents laufen über Waiver — stell einen Anspruch, er wird beim nächsten Waiver-Lauf entschieden.');
      windowGuard(league, rules);
      const own = S.ownership(league);
      if (!ros[me] || !ros[me].includes(body.out)) throw new HttpError(400, 'Du kannst nur einen eigenen Spieler abgeben.');
      if (!players.has(body.in)) throw new HttpError(400, 'Unbekannter Spieler.');
      if (own.has(body.in)) throw new HttpError(409, 'Der Spieler ist nicht mehr frei.');
      if (rules.perWeek > 0) {
        const wk = S.weekKey(now);
        const used = league.swaps.filter(x => x.manager === me && x.by === 'self' && x.at && S.weekKey(x.at) === wk).length;
        if (used >= rules.perWeek) throw new HttpError(409, `Diese Woche schon ${used} Free-Agent-Wechsel — erlaubt sind ${rules.perWeek}.`);
      }
      rosterGuard(league, players, rules, { [me]: ros[me].filter(x => x !== body.out).concat(body.in) });
      out = { manager: me, out: body.out, in: body.in, at: now, by: 'self' };
      league.swaps.push(out);
      return league;
    }

    if (!rules.enabled) throw new HttpError(403, 'Trades sind in dieser Liga nicht erlaubt.');
    if (action === 'propose') {
      windowGuard(league, rules);
      const give = [...new Set(body.give || [])], get = [...new Set(body.get || [])];
      if (!body.to || body.to === me || !ros[body.to]) throw new HttpError(400, 'Unbekannter Tauschpartner');
      if (!give.length || !get.length) throw new HttpError(400, 'Beide Seiten müssen mindestens einen Spieler geben');
      if (rules.equalCount && give.length !== get.length) throw new HttpError(400, 'Gleich viele Spieler auf beiden Seiten');
      if (!give.every(p => ros[me].includes(p))) throw new HttpError(400, 'Du kannst nur eigene Spieler anbieten');
      if (!get.every(p => ros[body.to].includes(p))) throw new HttpError(400, 'Die Spieler gehören nicht dem Tauschpartner');
      if (league.trades.some(t => t.status === 'proposed' && t.from === me && t.to === body.to
          && t.give.join() === give.join() && t.get.join() === get.join())) throw new HttpError(409, 'Genau diesen Trade hast du schon angeboten.');
      rosterGuard(league, players, rules, {
        [me]: ros[me].filter(x => !give.includes(x)).concat(get),
        [body.to]: ros[body.to].filter(x => !get.includes(x)).concat(give),
      });
      out = { id: 't' + randomHex(4), from: me, to: body.to, give, get, status: 'proposed', at: now };
      league.trades.push(out);
      return league;
    }
    const t = league.trades.find(x => x.id === body.id);
    if (!t) throw new HttpError(404, 'Trade nicht gefunden');
    if (t.status !== 'proposed') throw new HttpError(409, 'Der Trade ist schon entschieden');
    if (action === 'cancel') {
      if (t.from !== me) throw new HttpError(403, 'Nur wer vorschlägt, kann zurückziehen');
      t.status = 'cancelled'; t.decidedAt = now;
    } else if (action === 'respond') {
      if (t.to !== me) throw new HttpError(403, 'Der Trade ist nicht an dich');
      if (body.accept) {
        windowGuard(league, rules);
        // rosters may have changed since the proposal - check again
        if (!t.give.every(p => ros[t.from].includes(p)) || !t.get.every(p => ros[t.to].includes(p))) {
          t.status = 'rejected'; t.note = 'nicht mehr gültig — ein Spieler ist nicht mehr im Kader';
        } else {
          rosterGuard(league, players, rules, {
            [t.from]: ros[t.from].filter(x => !t.give.includes(x)).concat(t.get),
            [t.to]: ros[t.to].filter(x => !t.get.includes(x)).concat(t.give),
          });
          t.status = rules.adminApproval ? 'agreed' : 'accepted';
        }
      } else t.status = 'rejected';
      t.decidedAt = now;
    } else throw new HttpError(400, 'Unbekannte Aktion');
    out = t;
    return league;
  }, l => action === 'freeAgent'
    ? `transfer: ${mgrName(l, me)} holt ${(players.get(body.in) || {}).name || body.in} für ${(players.get(body.out) || {}).name || body.out}`
    : `trade: ${action} ${body.id || (out && out.id) || ''}`.trim());
  return out;
}

// ── waivers ───────────────────────────────────────────────────────────────
// Claims are private (KV claims:<manager>, ordered = that manager's own
// preference). A run resolves all claims at once in priority order: the
// manager with priority gets their first still-valid claim, then the order
// starts again from the top - the usual waiver procedure. Everything that was
// awarded lands in ONE league write; afterwards all claims are cleared.
const MAX_CLAIMS = 10;
export async function claimsOf(env, id) { return (await env.LEAGUE.get(`claims:${id}`, 'json')) || []; }

async function claimAction(env, me, body, players) {
  const { data: league } = await readLeagueFresh(env);
  const rules = S.transferRules(league);
  let list = await claimsOf(env, me);
  if (body.action === 'claim') {
    if (!rules.freeAgents) throw new HttpError(403, 'Free Agents sind in dieser Liga nicht erlaubt.');
    if (rules.faMode !== 'waiver') throw new HttpError(409, 'Free Agents laufen hier sofort — einfach holen.');
    windowGuard(league, rules);
    const mine = S.rosters(league)[me] || [];
    if (!mine.includes(body.out)) throw new HttpError(400, 'Du kannst nur einen eigenen Spieler abgeben.');
    if (!players.has(body.in)) throw new HttpError(400, 'Unbekannter Spieler.');
    if (S.ownership(league).has(body.in)) throw new HttpError(409, 'Der Spieler ist nicht frei.');
    if (list.some(c => c.in === body.in && c.out === body.out)) throw new HttpError(409, 'Den Anspruch hast du schon.');
    if (list.length >= MAX_CLAIMS) throw new HttpError(409, `Höchstens ${MAX_CLAIMS} Ansprüche gleichzeitig.`);
    list.push({ in: body.in, out: body.out, at: new Date().toISOString() });
  } else if (body.action === 'unclaim') {
    list = list.filter((_, i) => i !== Number(body.index));
  } else if (body.action === 'claimMove') {
    const i = Number(body.index), j = i + (Number(body.dir) < 0 ? -1 : 1);
    if (list[i] && list[j]) [list[i], list[j]] = [list[j], list[i]];
  }
  await env.LEAGUE.put(`claims:${me}`, JSON.stringify(list));
  return { claims: list };
}

async function statsForStandings(env) {
  const base = cfg(env).pages;
  const [st, ov] = await Promise.all([
    fetch(`${base}/data/stats.json`, { cf: { cacheTtl: 300, cacheEverything: true } }).then(r => r.json()).catch(() => ({ games: [] })),
    fetch(`${base}/data/overrides.json`, { cf: { cacheTtl: 60, cacheEverything: true } }).then(r => r.json()).catch(() => ({ rows: [] })),
  ]);
  return { games: S.applyOverrides(st.games || [], ov) };
}

// opts.force: admin "run now" - ignores the window check
export async function runWaivers(env, opts) {
  opts = opts || {};
  const { data: league0 } = await readLeagueFresh(env);
  const rules = S.transferRules(league0);
  if (!rules.freeAgents || rules.faMode !== 'waiver') return { skipped: 'Waiver sind nicht aktiv.' };
  if (S.draftStatus(league0) !== 'done') return { skipped: 'Erst nach dem Draft.' };
  if (!opts.force && !S.transferWindow(league0).open) return { skipped: 'Transferfenster ist zu.' };
  const ids = (league0.managers || []).map(m => m.id);
  const claims = {};
  for (const id of ids) claims[id] = await claimsOf(env, id);
  const total = Object.values(claims).reduce((n, l) => n + l.length, 0);
  if (!total) return { awarded: [], failed: [], skipped: 'Keine Ansprüche.' };
  const players = await playerIndex(env);
  const stats = await statsForStandings(env);
  let result = null;
  await writeLeague(env, league => {
    const now = new Date().toISOString();
    const order = S.waiverOrder(league, stats, players);
    const queue = Object.fromEntries(ids.map(id => [id, (claims[id] || []).slice()]));
    const awarded = [], failed = [];
    const wk = S.weekKey(now);
    league.swaps = league.swaps || [];
    const usedThisWeek = id => league.swaps.filter(x => x.manager === id && (x.by === 'self' || x.by === 'waiver') && x.at && S.weekKey(x.at) === wk).length;
    const opts2 = { roles: !!rules.rosterRules, teams: !!rules.teamLimit };
    let progress = true;
    while (progress) {
      progress = false;
      for (const id of order) {
        const q = queue[id] || [];
        while (q.length) {
          const c = q.shift();
          const own = S.ownership(league), ros = S.rosters(league)[id] || [];
          let why = null;
          if (!ros.includes(c.out)) why = 'abzugebender Spieler nicht mehr im Kader';
          else if (own.has(c.in)) why = 'Spieler schon vergeben';
          else if (!players.has(c.in)) why = 'Spieler nicht mehr im Pool';
          else if (rules.perWeek > 0 && usedThisWeek(id) >= rules.perWeek) why = 'Wochenlimit erreicht';
          else if (opts2.roles || opts2.teams) {
            const before = new Set(S.rosterProblems(league, players, ros, opts2));
            const added = S.rosterProblems(league, players, ros.filter(x => x !== c.out).concat(c.in), opts2).filter(x => !before.has(x));
            if (added.length) why = added.join(', ');
          }
          if (why) { failed.push({ manager: id, in: c.in, out: c.out, why }); continue; }
          league.swaps.push({ manager: id, out: c.out, in: c.in, at: now, by: 'waiver' });
          awarded.push({ manager: id, in: c.in, out: c.out });
          if (S.waiverRules(league).order === 'rolling') {
            const o = S.waiverOrder(league, stats, players).filter(x => x !== id);
            league.waiverOrder = o.concat(id);
            order.splice(order.indexOf(id), 1); order.push(id);
          }
          progress = true;
          break;   // one award, then start again from the top
        }
        if (progress) break;
      }
    }
    league.waiverRuns = [{ at: now, awarded: awarded.length, failed: failed.length }].concat(league.waiverRuns || []).slice(0, 20);
    result = { awarded, failed };
    return league;
  }, l => `waiver: ${result.awarded.length} Wechsel` + (result.awarded.length ? ' — ' + result.awarded.map(a => `${mgrName(l, a.manager)} holt ${(players.get(a.in) || {}).name || a.in}`).join(', ') : ''));
  for (const id of ids) await env.LEAGUE.delete(`claims:${id}`);
  return result;
}

// ── draft appointment ─────────────────────────────────────────────────────
//   draft.scheduledAt (ISO) · draft.reminderMinutes (default 60, 0 = none)
//   draft.autoStart (bool): lobby -> live at scheduledAt
// Called by the cron every minute. Returns what happened for notifications.
export async function draftSchedule(env, league) {
  const d = league.draft || {};
  if (S.draftStatus(league) !== 'lobby' || !d.scheduledAt) return null;
  const at = Date.parse(d.scheduledAt), now = Date.now();
  const remind = (d.reminderMinutes ?? 60) * 60000;
  const out = {};
  if (remind > 0 && now >= at - remind && now < at) {
    const key = 'remind:' + d.scheduledAt;
    if (!(await env.LEAGUE.get(key))) { await env.LEAGUE.put(key, '1', { expirationTtl: 14 * 86400 }); out.remind = true; }
  }
  if (d.autoStart && now >= at && (league.draft.order || []).length >= 2) {
    const r = await writeLeague(env, l => {
      if (S.draftStatus(l) !== 'lobby') return null;
      l.draft.status = 'live'; l.draft.completed = false; l.draft.startedAt = new Date().toISOString();
      return l;
    }, 'draft: automatisch gestartet (Termin)');
    if (r.changed) out.started = r.league;
  }
  return out;
}
