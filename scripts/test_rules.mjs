// ═══════════════════════════════════════════════════════════════════════════
// test_rules.mjs — the rules in scoring.js that go beyond points and snake
// order: lifecycle, capacity, trades over time, corrections, head-to-head and
// the consistency checker the admin page relies on.
//
//     node scripts/test_rules.mjs
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
globalThis.window = globalThis;
await import(path.join(ROOT, 'scoring.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
const S = globalThis.LECScoring;
const players = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'players.json'), 'utf8')).players;
const idx = new Map(players.map(p => [p.id, p]));

function league(n = 4) {
  return {
    name: 'T', scoring: { kill: 3, death: -1, assist: 1.5, cs10: 0.02, win: 2 },
    roster: { slots: ['TOP', 'JNG', 'MID', 'BOT', 'SUP'], bench: 1, maxPerTeam: 2 },
    managers: Array.from({ length: n }, (_, i) => ({ id: 'm' + (i + 1), name: 'M' + (i + 1) })),
    draft: { order: Array.from({ length: n }, (_, i) => 'm' + (i + 1)), snake: true, picks: [], status: 'live' },
    swaps: [], trades: [], adjustments: [],
  };
}
function fullDraft(L) {
  const pool = players.slice();
  while (S.currentPicker(L)) {
    const m = S.currentPicker(L);
    const p = pool.find(p => !S.pickError(L, idx, m, p.id));
    L.draft.picks.push({ manager: m, player: p.id });
  }
  L.draft.status = 'done'; L.draft.completed = true;   // the Worker locks a full draft
  return L;
}
const g = (game, player, ts, k = 1, win = false) => ({ game, match: 'M' + game, player, ts, k, d: 0, a: 0, cs: 0, win });

const tests = {};

tests.lobby_has_no_picker = () => {
  const L = league(); L.draft.status = 'lobby';
  assert(S.currentPicker(L) === null, 'nobody picks in the lobby');
  L.draft.status = 'live';
  assert(S.currentPicker(L) === 'm1', 'm1 opens');
  return 'lobby -> nobody, live -> m1';
};

tests.capacity_from_pool = () => {
  const cap = S.capacity(league(), idx);
  const minRole = Math.min(...['TOP', 'JNG', 'MID', 'BOT', 'SUP'].map(r => players.filter(p => p.role === r).length));
  const expect = Math.min(Math.floor(players.length * 0.8 / 6), minRole - 1);
  assert(cap === expect, `cap ${cap}, expected ${expect}`);
  return `pool of ${players.length} supports ${cap} managers (80% rule, smallest role ${minRole})`;
};

tests.never_stuck = () => {
  // more managers than capacity, worst-case greedy picking: relax levels
  // must still let every pick happen
  for (const n of [9, 10]) {
    const L = league(n);
    while (S.currentPicker(L)) {
      const m = S.currentPicker(L), lvl = S.relaxLevel(L, idx, m);
      const p = players.find(p => !S.pickError(L, idx, m, p.id, lvl));
      assert(p, `${n} managers stuck at pick ${L.draft.picks.length + 1}`);
      L.draft.picks.push({ manager: m, player: p.id });
    }
    L.draft.status = 'done';
    const v = S.validateLeague(L, idx);
    assert(!v.errors.length, JSON.stringify(v.errors));
  }
  return '9 and 10 managers finish; relaxed picks show up as warnings, never errors';
};

tests.any_number_of_managers_can_draft = () => {
  const cap = S.capacity(league(), idx);
  for (const n of [2, 3, 5, 7, cap]) {
    const L = fullDraft(league(n));
    assert(L.draft.picks.length === n * 6, `${n} managers: ${L.draft.picks.length} picks`);
    const v = S.validateLeague(L, idx);
    assert(!v.errors.length && !v.warnings.length, `${n} managers: ` + JSON.stringify(v));
  }
  return `full legal drafts for 2, 3, 5, 7 and ${cap} managers`;
};

tests.overrides = () => {
  const rows = [g('1', 'a', 't', 2), g('1', 'b', 't', 3), g('2', 'a', 't', 5)];
  const out = S.applyOverrides(rows, { rows: [
    { op: 'set', game: '1', player: 'a', fields: { k: 10, win: true } },
    { op: 'exclude', game: '2' },
    { op: 'add', row: g('3', 'c', 't', 1) }] });
  assert(out.length === 3, 'one excluded, one added');
  const a = out.find(r => r.player === 'a');
  assert(a.k === 10 && a.win && a.corrected, 'set applied and flagged');
  assert(rows[0].k === 2, 'input not mutated');
  return 'set / exclude / add, input untouched';
};

tests.trade_points_stay_with_old_owner = () => {
  const L = league(2);
  L.draft.picks = [{ manager: 'm1', player: 'x' }, { manager: 'm2', player: 'y' }];
  L.trades = [{ id: 't1', from: 'm1', to: 'm2', give: ['x'], get: ['y'], status: 'accepted', decidedAt: '2026-02-01T00:00:00Z' }];
  const stats = { games: [g('1', 'x', '2026-01-10T00:00:00Z', 10), g('2', 'x', '2026-02-10T00:00:00Z', 5)] };
  const st = S.standings(L, stats, new Map());
  const m1 = st.find(r => r.manager === 'm1'), m2 = st.find(r => r.manager === 'm2');
  assert(m1.total === 30, `m1 keeps x's pre-trade 30, got ${m1.total}`);
  assert(m2.total === 15, `m2 gets x's post-trade 15, got ${m2.total}`);
  assert(S.rosters(L).m2.includes('x') && S.rosters(L).m1.includes('y'), 'current rosters swapped');
  const x1 = m1.perPlayer.find(p => p.player === 'x');
  assert(x1 && !x1.current, 'x shown on m1 as former');
  return 'pre-trade points stay, post-trade points move, rosters swap';
};

tests.adjustments = () => {
  const L = league(2);
  L.adjustments = [{ manager: 'm2', pts: -5, reason: 'zu spät' }, { manager: 'm2', pts: 12.5, reason: 'Bonus' }];
  const st = S.standings(L, { games: [] }, new Map());
  const m2 = st.find(r => r.manager === 'm2');
  assert(m2.total === 7.5 && m2.adjust === 7.5, `got ${m2.total}`);
  return 'bonus/malus summed into total';
};

tests.h2h_round_robin = () => {
  for (const n of [2, 3, 4, 5, 6, 8]) {
    const ids = Array.from({ length: n }, (_, i) => 'm' + i);
    const met = new Set();
    const rounds = n % 2 ? n : n - 1;
    for (let r = 0; r < rounds; r++) {
      const seenThisRound = new Set();
      for (const [a, b] of S.h2hPairs(ids, r)) {
        for (const x of [a, b]) if (x) { assert(!seenThisRound.has(x), `${x} twice in round ${r}`); seenThisRound.add(x); }
        if (a && b) met.add([a, b].sort().join('-'));
      }
    }
    assert(met.size === n * (n - 1) / 2, `n=${n}: ${met.size} distinct pairings`);
  }
  return 'every pair meets exactly once per cycle (2–8 managers, byes for odd)';
};

tests.h2h_table = () => {
  const L = league(4);
  L.draft.picks = [{ manager: 'm1', player: 'a' }, { manager: 'm2', player: 'b' }, { manager: 'm3', player: 'c' }, { manager: 'm4', player: 'd' }];
  const sched = { events: ['M1', 'M2', 'M3', 'M4'].map(m => ({ match: m, start: '2026-01-10T17:00:00Z', state: 'completed', block: 'Week 1', tournament: 'sp1', teams: [] }))
    .concat([{ match: 'M9', start: '2099-01-17T17:00:00Z', state: 'unstarted', block: 'Week 2', tournament: 'sp1', teams: [] }]) };
  const stats = { games: [g('1', 'a', '2026-01-10T17:00:00Z', 4), g('2', 'b', '2026-01-10T17:00:00Z', 1), g('3', 'c', '2026-01-10T17:00:00Z', 2), g('4', 'd', '2026-01-10T17:00:00Z', 3)] };
  const r = S.h2h(L, stats, sched, new Map());
  const sum = r.table.reduce((t, x) => t + x.w + x.l + x.t, 0);
  assert(sum === 4, `4 results in week 1, got ${sum}`);
  assert(r.weeks[1].played === false, 'week 2 not played');
  assert(r.table[0].w === 1, 'leader has a win');
  return `week 1 decided (${r.table.map(t => t.name + ' ' + t.w + '-' + t.l).join(', ')}), week 2 pending`;
};

tests.two_per_role_draft = () => {
  for (const n of [4, 5]) {
    const L = league(n); L.roster = { slots: ['TOP', 'JNG', 'MID', 'BOT', 'SUP'], perRole: 2, maxPerTeam: 2 };
    while (S.currentPicker(L)) {
      const m = S.currentPicker(L), lvl = S.relaxLevel(L, idx, m);
      const p = players.find(p => !S.pickError(L, idx, m, p.id, lvl));
      assert(p, `${n} managers stuck at pick ${L.draft.picks.length + 1}`);
      L.draft.picks.push({ manager: m, player: p.id });
    }
    const ros = S.rosters(L);
    for (const [m, ids] of Object.entries(ros)) {
      assert(ids.length === 10, `${m} has ${ids.length}`);
      const per = {}; for (const id of ids) per[idx.get(id).role] = (per[idx.get(id).role] || 0) + 1;
      assert(Object.values(per).every(v => v === 2), `${m} roles ${JSON.stringify(per)}`);
    }
  }
  const L = league(4); L.roster = { slots: ['TOP', 'JNG', 'MID', 'BOT', 'SUP'], perRole: 2, maxPerTeam: 2 };
  return `10-man rosters, exactly 2 per role, 4 and 5 managers never stuck; suggested capacity ${S.suggestedCapacity(L, idx)}`;
};

// fixture for lineups: one manager, two players per role (TOP/MID only to keep it small)
function lineupLeague() {
  const L = league(1);
  L.roster = { slots: ['TOP', 'MID'], perRole: 2, maxPerTeam: 9 };
  L.draft.picks = ['t1', 't2', 'm1x', 'm2x'].map(p => ({ manager: 'm1', player: p }));
  L.lineup = { enabled: true, captain: 1.5 };
  const pi = new Map([['t1', { role: 'TOP' }], ['t2', { role: 'TOP' }], ['m1x', { role: 'MID' }], ['m2x', { role: 'MID' }]]);
  const sched = { events: [
    { match: 'A', start: '2026-01-10T17:00:00Z', state: 'completed', block: 'Week 1', tournament: 'sp', teams: [] },
    { match: 'B', start: '2026-01-17T17:00:00Z', state: 'completed', block: 'Week 2', tournament: 'sp', teams: [] }] };
  return { L, pi, sched };
}
const gg = (game, match, player, ts, k) => ({ game, match, player, ts, k, d: 0, a: 0, cs: 0, win: false });

tests.lineup_auto_captain_autosub = () => {
  const { L, pi, sched } = lineupLeague();
  // week 1: everyone plays. t1 better than t2, m1x better than m2x
  const stats = { games: [gg('g1', 'A', 't1', '2026-01-10T17:00:00Z', 10), gg('g1', 'A', 't2', '2026-01-10T17:00:00Z', 1),
                          gg('g1', 'A', 'm1x', '2026-01-10T17:00:00Z', 5), gg('g1', 'A', 'm2x', '2026-01-10T17:00:00Z', 2),
  // week 2: t1 (the best TOP, auto starter + captain) does NOT play; t2 plays
                          gg('g2', 'B', 't2', '2026-01-17T17:00:00Z', 4), gg('g2', 'B', 'm1x', '2026-01-17T17:00:00Z', 6),
                          gg('g2', 'B', 'm2x', '2026-01-17T17:00:00Z', 9)] };
  const book = S.scoreBook(L, stats, pi, sched).m1;
  // Nobody ever saved a lineup here, so both weeks use the neutral fallback:
  // a stable, opinion-free fill per role. It must NOT sort by form - picking
  // the in-form player would be the system playing the manager's game for him
  // (see test_lineup_neutral.mjs). Week 2 must therefore look like week 1.
  const w1 = book.lineups['sp|Week 1'];
  assert(w1.auto && w1.starters.length === 2, 'week 1 fallback lineup');
  const w2 = book.lineups['sp|Week 2'];
  assert(w2.starters.join() === w1.starters.join(),
    'week 2 keeps week 1, no form re-optimisation: ' + JSON.stringify(w2.starters) + ' vs ' + JSON.stringify(w1.starters));
  assert(w2.subs.length === 1 && w2.subs[0].out === 't1' && w2.subs[0].in === 't2', 'auto-sub t2 for t1');
  assert(w2.captainScored === 'm1x', 'vice inherits the captaincy');
  // week 2 points: t2 4*3=12, m1x 6*3=18 x1.5=27, m2x (bench) not counted
  assert(book.byBlock['sp|Week 2'] === 39, 'week 2 = 12 + 27, got ' + book.byBlock['sp|Week 2']);
  assert(book.perPlayer.m2x.benchPts === 33, 'bench points tracked (week 1: 6, week 2: 27), not counted, got ' + book.perPlayer.m2x.benchPts);
  // a saved lineup is respected
  L.lineups = { m1: { 'sp|Week 2': { starters: ['t2', 'm2x'], captain: 'm2x', vice: 't2' } } };
  const b2 = S.scoreBook(L, stats, pi, sched).m1;
  assert(b2.byBlock['sp|Week 2'] === 12 + 40.5, 'saved lineup: t2 12 + m2x 27x1.5, got ' + b2.byBlock['sp|Week 2']);
  // set in week 1 only -> carried into week 2
  L.lineups = { m1: { 'sp|Week 1': { starters: ['t2', 'm2x'], captain: 'm2x', vice: 't2' } } };
  assert(S.scoreBook(L, stats, pi, sched).m1.byBlock['sp|Week 2'] === 12 + 40.5, 'week 1 lineup carried into week 2');
  // lineups off -> everyone counts
  L.lineup.enabled = false;
  assert(S.scoreBook(L, stats, pi, sched).m1.byBlock['sp|Week 2'] === 12 + 18 + 27, 'lineups off: all count');
  return 'auto lineup from prior averages, auto-sub, vice inherits captain, bench not counted, saved lineup wins, off = all count';
};

tests.week_recap_and_hall = () => {
  const { L, pi, sched } = lineupLeague();
  const stats = { games: [gg('g1', 'A', 't1', '2026-01-10T17:00:00Z', 10), gg('g1', 'A', 't2', '2026-01-10T17:00:00Z', 1),
                          gg('g1', 'A', 'm1x', '2026-01-10T17:00:00Z', 5), gg('g1', 'A', 'm2x', '2026-01-10T17:00:00Z', 2),
                          gg('g2', 'B', 't2', '2026-01-17T17:00:00Z', 4), gg('g2', 'B', 'm1x', '2026-01-17T17:00:00Z', 6),
                          gg('g2', 'B', 'm2x', '2026-01-17T17:00:00Z', 9), gg('g2', 'B', 'free1', '2026-01-17T17:00:00Z', 20)] };
  stats.games.forEach(g => { g.tournament = 'sp'; });
  pi.set('free1', { role: 'TOP', name: 'Free' });
  // week 2: t2 subs in for t1 (12), m1x is the vice-captain (6*3*1.5 = 27), m2x (27) sits on the bench
  const r = S.weekRecap(L, stats, pi, sched, 'sp|Week 2');
  assert(r.ranking[0].pts === 39, 'week score 39, got ' + r.ranking[0].pts);
  assert(r.best.player === 'm1x' && r.best.pts === 18 && r.best.captain, 'player of the week = m1x (raw 18, scored as captain): ' + JSON.stringify(r.best));
  assert(r.flop.player === 't2' && r.flop.pts === 12, 'flop = t2: ' + JSON.stringify(r.flop));
  assert(r.benchPain && r.benchPain.pts === 27, 'bench pain 27: ' + JSON.stringify(r.benchPain));
  assert(r.freeBest && r.freeBest.player === 'free1', 'best unowned player found');
  assert(!r.record, 'week 1 (52.5) was higher - no record');
  assert(S.weekRecap(L, stats, pi, sched, 'sp|Week 1').record, 'week 1 is the record');
  assert(S.weekRecap(L, { games: [] }, pi, sched, 'sp|Week 2') === null, 'no stats -> null');
  // hall of fame
  L.draft.status = 'done'; L.draft.startedAt = '2026-01-01T00:00:00Z';
  const h = S.hallEntry(L, stats, pi, sched, 'sp', null);
  assert(h.table.length === 1 && h.table[0].pts === 91.5, 'split total 52.5 + 39, got ' + JSON.stringify(h.table));
  assert(h.bestWeek && h.bestWeek.week === 'Week 1' && h.bestWeek.pts === 52.5, 'best week');
  assert(h.steal && h.steal.player === 'm1x' && h.bust && h.bust.player === 't1', 'steal m1x (pick 3 -> 1st), bust t1 (pick 1 -> 3rd) ' + JSON.stringify(h.steal));
  const season = { tournaments: [{ slug: 'sp', lastMatch: '2026-01-17T17:00:00Z', done: true }, { slug: 'sp2', lastMatch: '2099-01-01T00:00:00Z', done: false }] };
  assert(JSON.stringify(S.hallDue(L, season, Date.parse('2026-01-18T12:00:00Z'))) === '["sp"]', 'due 12 h after the last match');
  assert(S.hallDue(L, season, Date.parse('2026-01-17T20:00:00Z')).length === 0, 'not right after the final');
  assert(S.hallDue(Object.assign({}, L, { hall: { sp: h } }), season, Date.parse('2026-01-18T12:00:00Z')).length === 0, 'never twice');
  const late = JSON.parse(JSON.stringify(L)); late.draft.startedAt = '2026-02-01T00:00:00Z';
  assert(S.hallDue(late, season, Date.parse('2026-03-01T00:00:00Z')).length === 0, 'drafted after the split: no entry');
  return 'recap: winner, player/flop of the week, bench pain, best free player, record; hall: totals, best week, steal, due timing';
};

function eventFixture() {
  const R = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
  const teams = [['AAA', 'LCK'], ['BBB', 'LEC'], ['CCC', 'LCS'], ['DDD', 'LPL']].map(([code, league]) => ({ code, league, name: code }));
  const players = teams.flatMap(t => R.map(r => ({ id: t.code + '_' + r, name: t.code + r, team: t.code, role: r })));
  const m = (id, stage, start, a, b, win) => ({ match: id, stage, start, state: 'completed', teams: [{ code: a, outcome: win === a ? 'win' : 'loss' }, { code: b, outcome: win === b ? 'win' : 'loss' }] });
  const schedule = [m('s1', 0, '2026-10-15T10:00:00Z', 'AAA', 'BBB', 'AAA'), m('s2', 0, '2026-10-15T12:00:00Z', 'CCC', 'DDD', 'DDD'),
    m('s3', 0, '2026-10-16T10:00:00Z', 'AAA', 'DDD', 'AAA'), m('s4', 0, '2026-10-16T12:00:00Z', 'BBB', 'CCC', 'BBB'),
    m('s5', 0, '2026-10-17T10:00:00Z', 'AAA', 'CCC', 'AAA'), m('s6', 0, '2026-10-17T12:00:00Z', 'BBB', 'DDD', 'DDD'),
    m('k1', 1, '2026-10-20T10:00:00Z', 'AAA', 'DDD', 'DDD')];
  const g = (match, player, k) => ({ game: match + 'g', match, player, k, d: 0, a: 0, cs: 0, win: false, dur: 1800 });
  const games = [g('s1', 'AAA_MID', 10), g('s1', 'BBB_MID', 2), g('k1', 'AAA_MID', 4), g('k1', 'DDD_MID', 8)];
  return { teams, players, schedule, games, stages: [{ name: 'Swiss' }, { name: 'Knockouts' }] };
}

tests.events = () => {
  const d = eventFixture(), sc = { kill: 3, death: 0, assist: 0, cs10: 0, win: 0 };
  const st = S.eventStages(d);
  assert(st.length === 2 && st[0].done && st[1].done && st[1].lock === Date.parse('2026-10-20T10:00:00Z'), 'stages with locks');
  assert(S.eventOpenStage(d, Date.parse('2026-10-01T00:00:00Z')) === 0 && S.eventOpenStage(d, Date.parse('2026-10-18T00:00:00Z')) === 1 && S.eventOpenStage(d, Date.parse('2026-11-01T00:00:00Z')) === null, 'open stage by time');
  const ev = { slug: 'w', prices: { AAA: 30 } };
  const team = (ids, cap) => ({ players: ids, captain: cap });
  assert(S.eventTeamPrice(ev, d, 'AAA') === 30 && S.eventTeamPrice(ev, d, 'BBB') === 20 && S.eventTeamPrice(ev, d, 'CCC') === 15, 'admin price, else by region');
  const ok = team(['AAA_TOP', 'BBB_JNG', 'AAA_MID', 'CCC_BOT', 'CCC_SUP'], 'AAA_MID');           // 30+20+30+15+15 = 110
  assert(/Zu teuer: 110/.test(S.eventTeamError(ev, d, ok)), 'budget');
  const fine = team(['AAA_TOP', 'BBB_JNG', 'AAA_MID', 'CCC_BOT', 'CCC_SUP'], 'AAA_MID');
  assert(S.eventTeamError(Object.assign({}, ev, { budget: 110 }), d, fine) === null, 'valid at budget 110');
  assert(/pro Rolle/.test(S.eventTeamError(ev, d, team(['AAA_TOP', 'BBB_TOP', 'CCC_MID', 'CCC_BOT', 'DDD_SUP'], 'AAA_TOP'))), 'one per role');
  assert(/pro Team/.test(S.eventTeamError(Object.assign({}, ev, { budget: 999 }), d, team(['AAA_TOP', 'AAA_JNG', 'AAA_MID', 'CCC_BOT', 'DDD_SUP'], 'AAA_TOP'))), 'max 2 per team');
  assert(/Kapitän/.test(S.eventTeamError(Object.assign({}, ev, { budget: 999 }), d, team(fine.players, 'DDD_MID'))), 'captain must be own');
  // lineups: stage 0 set, stage 1 carried; captain x1.5
  const lev = Object.assign({}, ev, { budget: 999, lineups: { 0: { a: fine, b: team(['DDD_TOP', 'BBB_JNG', 'BBB_MID', 'CCC_BOT', 'CCC_SUP'], 'BBB_MID') }, 1: { b: team(['DDD_TOP', 'BBB_JNG', 'DDD_MID', 'CCC_BOT', 'CCC_SUP'], 'DDD_MID') } } });
  const L = { managers: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Ben' }], scoring: sc };
  const rows = S.eventStandings(L, lev, d);
  const A = rows.find(r => r.manager === 'a'), B = rows.find(r => r.manager === 'b');
  assert(A.players === 30 * 1.5 + 12 * 1.5 && A.byStage[1] === 18, 'Ann: captain both stages, stage 1 carried: ' + JSON.stringify(A));
  assert(B.players === 6 * 1.5 + 24 * 1.5, 'Ben: stage-1 lineup counts in stage 1: ' + JSON.stringify(B));
  // truth: champion DDD (LPL), finalists, swiss 3-0 AAA, 0-3 CCC
  const t = S.eventTruth(d, sc);
  assert(t.champion.has('DDD') && t.finalist.has('AAA') && t.winnerRegion.has('LPL') && t.swiss30.has('AAA') && t.swiss03.has('CCC') && t.mostKills.has('AAA_MID'), 'truth: ' + JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v instanceof Set ? [...v] : v]))));
  lev.pickem = { revealed: true, questions: [{ id: 'q1', type: 'champion', points: 10 }, { id: 'q2', type: 'swiss30', points: 5 }, { id: 'q3', type: 'bloodiest', points: 3 }],
    picks: { a: { q1: 'DDD', q2: 'BBB', q3: '13' }, b: { q1: 'AAA', q2: 'AAA', q3: '5' } } };
  const r2 = S.eventStandings(L, lev, d);
  assert(r2.find(r => r.manager === 'a').pickem === 13 && r2.find(r => r.manager === 'b').pickem === 5, 'pick\'em points (closest number wins)');
  // multi picks (points per correct team) and a second round before the knockouts
  lev.pickem.questions.push({ id: 'q4', type: 'advance8', points: 2 });
  lev.pickem.picks.a.q4 = 'AAA,BBB,DDD';                         // AAA + DDD made it: 2 x 2
  lev.pickemKo = { revealed: true, questions: [{ id: 'q1', type: 'finalScore', points: 10 }, { id: 'q2', type: 'koFinal', points: 5 }],
    picks: { b: { q1: '1:0', q2: 'DDD,AAA' } } };
  d.schedule[d.schedule.length - 1].teams = [{ code: 'AAA', outcome: 'loss', wins: 0 }, { code: 'DDD', outcome: 'win', wins: 1 }];
  d.schedule[d.schedule.length - 1].bestOf = 1;
  const r3 = S.eventStandings(L, lev, d);
  const A3 = r3.find(r => r.manager === 'a'), B3 = r3.find(r => r.manager === 'b');
  assert(A3.pickem === 13 + 4 && A3.hits.q4 === 2, 'advance8: 2 of 3 right = 4 points: ' + JSON.stringify(A3));
  assert(B3.pickem === 5 + 10 + 10 && B3.correct.includes('ko:q1') && B3.hits['ko:q2'] === 2, 'ko round: exact final score + both finalists: ' + JSON.stringify(B3));
  assert(JSON.stringify(S.eventFinalScores(d)) === '["1:0"]' && S.eventLevels(d).join() === 'Swiss,Knockouts,Halbfinale,Finale,Sieger', 'score options + levels');
  return 'stages + locks, prices (admin / region), budget, roles, team limit, captain, carry-over lineups, truth incl. Swiss 3-0/0-3 and region, pick\'em';
};

tests.pickem = () => {
  const L = league(2);
  const ev = (m, block, a, b, aw, start) => ({ match: m, start, state: 'completed', block, tournament: 'sp',
    teams: [{ code: a, outcome: aw ? 'win' : 'loss', wins: aw ? 1 : 0 }, { code: b, outcome: aw ? 'loss' : 'win', wins: aw ? 0 : 1 }] });
  const sched = { events: [ev('1', 'Week 1', 'G2', 'FNC', true, '2026-01-10T17:00:00Z'), ev('2', 'Week 1', 'KC', 'FNC', true, '2026-01-11T17:00:00Z'),
    ev('3', 'Week 1', 'G2', 'KC', true, '2026-01-12T17:00:00Z'), ev('4', 'Finals', 'KC', 'G2', true, '2026-01-20T17:00:00Z')] };
  const row = (game, player, champ, k, dur) => ({ game, match: '1', player, champ, k, d: 1, a: 0, cs: 0, win: false, tournament: 'sp', dur, ts: '2026-01-10T17:00:00Z' });
  const stats = { games: [row('x', 'p1', 'Ahri', 9, 1800), row('x', 'p2', 'Ahri', 2, 1800), row('y', 'p1', 'Zed', 1, 2400), row('y', 'p2', 'Ahri', 3, 2400)] };
  const t = S.pickemTruth(L, stats, sched, 'sp', new Map());
  assert(t.champion.has('KC') && t.finalist.has('G2') && t.firstRegular.has('G2') && t.lastRegular.has('FNC'), 'teams');
  assert(t.mostKills.has('p1') && t.mostPicked.has('Ahri') && t.longestGame === 40 && t.bloodiest === 11, 'stats ' + JSON.stringify([t.longestGame, t.bloodiest]));
  L.pickems = { sp: { revealed: true, questions: [{ id: 'q1', type: 'champion', points: 10 }, { id: 'q2', type: 'longestGame', points: 5 }, { id: 'q3', type: 'manualChamp', points: 3, answer: 'Zed' }],
    picks: { m1: { q1: 'KC', q2: '38', q3: 'Zed' }, m2: { q1: 'G2', q2: '45', q3: 'Ahri' } } } };
  const pts = S.pickemPoints(L, stats, sched, new Map());
  assert(pts.m1.total === 18 && pts.m2.total === 0, 'm1 18 (10+5 closest+3 manual), m2 0: ' + JSON.stringify(pts));
  const st = S.standings(L, stats, new Map(), sched);
  assert(st.find(r => r.manager === 'm1').pickem === 18 && st.find(r => r.manager === 'm1').total === 18, 'pickem added to total');
  // not before the split is over
  sched.events.push({ match: '5', start: '2099-01-01T00:00:00Z', state: 'unstarted', block: 'Finals', tournament: 'sp', teams: [] });
  assert(!S.pickemPoints(L, stats, sched, new Map()).m1, 'nothing counts while the split runs');
  return 'champion/finalist/regular season/stats truths, closest guess, manual answer, added to totals only after the split';
};

tests.auto_windows_and_faab = () => {
  const season = { tournaments: [
    { slug: 'lec_split_1_2027', start: '2027-01-10', lastMatch: '2027-03-01T17:00:00Z', firstMatch: '2027-01-11T17:00:00Z' },
    { slug: 'lec_split_2_2027', start: '2027-03-25', firstMatch: '2027-03-28T16:00:00Z', lastMatch: null }] };
  const L = league(2); L.tradeRules = { mode: 'windows', windows: [], autoWindows: true };
  const w = S.autoWindows(season);
  assert(w.length === 1 && w[0].from === '2027-03-01T23:00:00.000Z' && w[0].to === '2027-03-28T15:00:00.000Z', JSON.stringify(w));
  assert(S.transferWindow(L, '2027-03-10T12:00:00Z', season).open, 'open between splits');
  assert(!S.transferWindow(L, '2027-02-10T12:00:00Z', season).open, 'closed during split 1');
  L.tradeRules.autoWindows = false;
  assert(!S.transferWindow(L, '2027-03-10T12:00:00Z', season).open, 'auto off -> closed');
  L.faab = { budget: 100 };
  L.swaps = [{ manager: 'm1', by: 'waiver', bid: 30, at: '2027-01-20T00:00:00Z' }, { manager: 'm1', by: 'waiver', bid: 15, at: '2027-03-30T00:00:00Z' }];
  assert(S.faabLeft(L, 'm1') === 55 && S.faabLeft(L, 'm2') === 100, 'budget left');
  return 'window from 6 h after a split to 1 h before the next, toggle, FAAB budget';
};

tests.validator_finds_problems = () => {
  const L = fullDraft(league(4));
  assert(!S.validateLeague(L, idx).errors.length, 'clean draft has no errors');
  const dup = JSON.parse(JSON.stringify(L));
  dup.draft.picks[5].player = dup.draft.picks[1].player;
  const v = S.validateLeague(dup, idx);
  assert(v.errors.some(e => /doppelt/.test(e.msg) && e.fix && e.fix.op === 'removePick'), 'duplicate pick -> error with fix');
  const ooo = JSON.parse(JSON.stringify(L));
  ooo.draft.picks[0].manager = 'm2';
  assert(S.validateLeague(ooo, idx).warnings.some(w => /außer der Reihe/.test(w.msg)), 'out of order -> warning');
  const bad = JSON.parse(JSON.stringify(L)); bad.scoring.kill = 'x';
  assert(S.validateLeague(bad, idx).errors.some(e => /scoring.kill/.test(e.msg)), 'bad scoring -> error');
  const ghost = JSON.parse(JSON.stringify(L)); ghost.draft.order.push('zz');
  assert(S.validateLeague(ghost, idx).errors.some(e => e.fix && e.fix.op === 'setOrder'), 'unknown manager in order -> fixable');
  return 'duplicates, order, bad scoring, ghost managers all caught, with fixes';
};

tests.transfer_window_and_roster = () => {
  const L = league(2);
  assert(!S.transferWindow(L).open, 'no rules = closed');
  L.tradeRules = { mode: 'windows', windows: [{ from: '2027-01-10T00:00:00Z', to: '2027-01-20T23:59:59Z' }, { from: '2027-04-01T00:00:00Z', to: '2027-04-05T00:00:00Z' }] };
  const at = x => S.transferWindow(L, x);
  assert(!at('2027-01-05T00:00:00Z').open && at('2027-01-05T00:00:00Z').next.from.startsWith('2027-01-10'), 'before: closed, next known');
  assert(at('2027-01-15T12:00:00Z').open, 'inside: open');
  assert(!at('2027-02-01T00:00:00Z').open && at('2027-02-01T00:00:00Z').next.from.startsWith('2027-04'), 'between: closed, next is April');
  L.tradeRules.mode = 'always';
  assert(S.transferWindow(L, '2030-01-01T00:00:00Z').open, 'always: open');
  const pi = new Map([['a', { role: 'TOP', team: 'G2' }], ['b', { role: 'JNG', team: 'G2' }], ['c', { role: 'MID', team: 'G2' }], ['d', { role: 'BOT', team: 'FNC' }], ['e', { role: 'SUP', team: 'FNC' }]]);
  const probs = S.rosterProblems(L, pi, ['a', 'b', 'c', 'd']);
  assert(probs.some(x => /SUP/.test(x)) && probs.some(x => /3 von G2/.test(x)), JSON.stringify(probs));
  assert(S.rosterProblems(L, pi, ['a', 'b', 'c', 'd'], { teams: false }).every(x => !/von/.test(x)), 'teams switch');
  assert(S.weekKey('2027-01-13T22:00:00Z') === '2027-01-11' && S.weekKey('2027-01-17T23:00:00Z') === '2027-01-11', 'Mon-Sun weeks');
  return 'windows (before/inside/between/always), roster problems, week keys';
};

tests.bonus_and_berlin_time = () => {
  const s = { kill: 3, death: -1, assist: 1.5, cs10: 0, win: 2, bonus: { enabled: true, threshold: 10, points: 2 } };
  assert(S.gamePoints({ k: 10, d: 0, a: 0 }, s) === 32, '10 kills -> +2');
  assert(S.gamePoints({ k: 0, d: 0, a: 10 }, s) === 17, '10 assists -> +2');
  assert(S.gamePoints({ k: 9, d: 0, a: 9 }, s) === 40.5, '9/9 -> no bonus');
  s.bonus.enabled = false;
  assert(S.gamePoints({ k: 10, d: 0, a: 0 }, s) === 30, 'bonus off');
  const L = { tradeRules: { waiver: { days: [2], time: '03:00' } } };
  // Tuesday 03:00 German time: 01:00 UTC in summer, 02:00 UTC in winter
  assert(new Date(S.nextWaiverRun(L, Date.parse('2026-10-02T10:00:00Z'))).toISOString() === '2026-10-06T01:00:00.000Z', 'summer time');
  assert(new Date(S.nextWaiverRun(L, Date.parse('2026-10-28T10:00:00Z'))).toISOString() === '2026-11-03T02:00:00.000Z', 'winter time');
  assert(new Date(S.lastWaiverSlot(L, Date.parse('2026-11-04T10:00:00Z'))).toISOString() === '2026-11-03T02:00:00.000Z', 'last slot');
  return 'bonus on/off and threshold; Tue 03:00 Berlin = 01:00Z summer / 02:00Z winter';
};

function assert(c, m) { if (!c) throw new Error(m); }
let failed = 0;
for (const [n, t] of Object.entries(tests)) {
  try { console.log(`  ok  ${n}: ${t()}`); } catch (e) { failed++; console.log(`  FAIL ${n}: ${e.message}`); }
}
console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
