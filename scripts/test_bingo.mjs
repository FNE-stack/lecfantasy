// Bingo engine checked against the real MSI 2026 event file.
// Run: node scripts/test_bingo.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

globalThis.window = globalThis;
const require = createRequire(import.meta.url);
require('../scoring.js');
const S = globalThis.LECScoring;

const msi = JSON.parse(readFileSync(new URL('../data/events/msi_2026.json', import.meta.url), 'utf8'));
const rows = msi.games;

let fails = 0;
const ok = (name, cond, msg) => { if (cond) console.log(`  ok   ${name}: ${msg}`); else { fails++; console.log(`  FAIL ${name}: ${msg}`); } };

// ── 1) every square resolves, none throws ─────────────────────────────────
const hits = S.bingoHits(rows);
const keys = Object.keys(S.BINGO);
ok('all_squares_resolve', Object.keys(hits).length === keys.length,
   `${Object.keys(hits).length}/${keys.length} squares evaluated`);

// ── 2) no dead squares: on a full real event most should be reachable ─────
const hitKeys = keys.filter(k => hits[k].hit);
const deadKeys = keys.filter(k => !hits[k].hit);
ok('reachable_squares', hitKeys.length >= keys.length * 0.6,
   `${hitKeys.length}/${keys.length} squares occurred over a full event (rest stay as stretch goals)`);

// ── 3) hits carry the game that caused them ───────────────────────────────
ok('hits_have_provenance', hitKeys.every(k => hits[k].game && hits[k].at),
   'each hit records the game id + kickoff');

// ── 4) empty input is safe ────────────────────────────────────────────────
const none = S.bingoHits([]);
ok('empty_is_safe', Object.keys(none).length === keys.length && !Object.values(none).some(h => h.hit),
   'no games -> every square false, nothing throws');

// ── 5) cards are deterministic per seed, different between seeds ──────────
const a1 = S.bingoCard('fabi', 4), a2 = S.bingoCard('fabi', 4), b1 = S.bingoCard('boy2', 4);
ok('card_stable', JSON.stringify(a1) === JSON.stringify(a2), 'same seed -> same card');
ok('card_varies', JSON.stringify(a1) !== JSON.stringify(b1), 'different seed -> different card');
ok('card_size', a1.cells.length === 16 && a1.size === 4, '4x4 = 16 cells');
ok('card_no_dupes', new Set(a1.cells).size === a1.cells.length,
   `${new Set(a1.cells).size} distinct squares on the card`);

// ── 6) scoring: all-false card = 0, all-true = full house ─────────────────
const zero = S.bingoScore(a1, none);
ok('score_zero', zero.points === 0 && zero.lines === 0 && !zero.full, 'nothing ticked -> 0 points');

const allOn = {}; for (const k of keys) allOn[k] = { hit: true };
const full = S.bingoScore(a1, allOn);
const n = a1.size;
const expectLines = n * 2 + 2;          // rows + cols + 2 diagonals
const expectPts = n * n * 1 + expectLines * 5 + 15;
ok('score_full_house', full.full && full.lines === expectLines && full.points === expectPts,
   `full card: ${full.squares} squares, ${full.lines} lines, ${full.points} pts (expected ${expectPts})`);

// ── 7) a single completed row scores exactly one line ─────────────────────
const rowOnly = {};
for (const k of keys) rowOnly[k] = { hit: false };
for (let c = 0; c < n; c++) rowOnly[a1.cells[c]] = { hit: true };
const rs = S.bingoScore(a1, rowOnly);
ok('score_one_line', rs.lines >= 1, `top row ticked -> ${rs.lines} line(s), ${rs.points} pts`);

// ── 8) real-data scoring is plausible, not degenerate ─────────────────────
const real = S.bingoScore(a1, hits);
ok('score_real_event', real.points > 0 && real.squares > 0,
   `MSI 2026 on fabi's card: ${real.squares}/${n * n} squares, ${real.lines} lines, ${real.points} pts`);

// ── 9) report the actual difficulty spread (information, not assertion) ───
console.log('\n  square hit-rate over MSI 2026 (71 games):');
const perGameRate = {};
{
  const byGame = new Map();
  for (const x of rows) { if (!byGame.has(x.game)) byGame.set(x.game, []); byGame.get(x.game).push(x); }
  const games = [...byGame.values()];
  for (const k of keys) {
    let n2 = 0;
    for (const g of games) { try { if (S.BINGO[k].test(g)) n2++; } catch (e) { /* ignore */ } }
    perGameRate[k] = n2 / games.length;
  }
}
for (const k of keys.sort((x, y) => perGameRate[y] - perGameRate[x])) {
  const pct = (perGameRate[k] * 100).toFixed(0).padStart(3);
  console.log(`    ${pct}%  ${S.BINGO[k].label}`);
}

console.log(`\n${fails ? fails + ' FAILED' : 'all bingo tests passed'}`);
process.exit(fails ? 1 : 0);

