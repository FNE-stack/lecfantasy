// ═══════════════════════════════════════════════════════════════════════════
// draft.js — joining, picking, the pick timer and trades.
//
// One pick path (makePick) for members, the admin and the auto-pick, so all
// three obey exactly the same rules. Every decision is made inside
// writeLeague's mutate callback, i.e. re-checked on the freshest league on
// every retry - two simultaneous picks can never both pass.
// ═══════════════════════════════════════════════════════════════════════════
import { S, HttpError, writeLeague, playerIndex, seasonPoints } from './store.js';
import { randomHex } from './auth.js';

export const nameKey = n => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
export function cleanName(n) {
  const s = String(n || '').trim().replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 24) throw new HttpError(400, 'Name: 2–24 Zeichen');
  if (/[<>"]/.test(s)) throw new HttpError(400, 'Name enthält ungültige Zeichen');
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
  if (!rules.rosterRules) return;
  const now = S.rosters(league);
  for (const [mgr, ids] of Object.entries(rostersAfter)) {
    const before = new Set(S.rosterProblems(league, players, now[mgr] || []));
    const added = S.rosterProblems(league, players, ids).filter(x => !before.has(x));
    if (added.length) throw new HttpError(422, `Danach hätte ${mgrName(league, mgr)}: ${added.join(', ')}.`);
  }
}

export async function tradeAction(env, me, body) {
  const action = body.action;
  const players = await playerIndex(env);
  let out = null;
  await writeLeague(env, league => {
    const rules = S.transferRules(league);
    league.trades = league.trades || [];
    league.swaps = league.swaps || [];
    const ros = S.rosters(league);
    const now = new Date().toISOString();

    if (action === 'freeAgent') {
      if (!rules.freeAgents) throw new HttpError(403, 'Free Agents sind in dieser Liga nicht erlaubt.');
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
