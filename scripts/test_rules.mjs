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
  const weekOf = new Map([['M1', 'Week 1'], ['M2', 'Week 1'], ['M3', 'Week 1'], ['M4', 'Week 1']]);
  const stats = { games: [g('1', 'a', 't', 4), g('2', 'b', 't', 1), g('3', 'c', 't', 2), g('4', 'd', 't', 3)] };
  const r = S.h2h(L, stats, weekOf, ['Week 1', 'Week 2']);
  const sum = r.table.reduce((t, x) => t + x.w + x.l + x.t, 0);
  assert(sum === 4, `4 results in week 1, got ${sum}`);
  assert(r.weeks[1].played === false, 'week 2 not played');
  const top = r.table[0];
  assert(top.w === 1, 'leader has a win');
  return `week 1 decided (${r.table.map(t => t.name + ' ' + t.w + '-' + t.l).join(', ')}), week 2 pending`;
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

function assert(c, m) { if (!c) throw new Error(m); }
let failed = 0;
for (const [n, t] of Object.entries(tests)) {
  try { console.log(`  ok  ${n}: ${t()}`); } catch (e) { failed++; console.log(`  FAIL ${n}: ${e.message}`); }
}
console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
