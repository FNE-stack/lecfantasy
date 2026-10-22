// Bingo pacing. After day 1 of the Worlds play-ins somebody already had a line,
// which is far too quick for a month-long event. Two things were wrong: the
// pool was too soft (half of it ticked with >95% chance over a Worlds) and a
// card could be filled entirely from those near-certainties.
//
// These tests pin the fix, because it is easy to undo by accident - adding a
// handful of crowd-pleasing common squares would quietly make the board solve
// itself again.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

globalThis.window = globalThis;
const require = createRequire(import.meta.url);
require('../scoring.js');
const S = globalThis.LECScoring;

let fails = 0;
const ok = (n, c, m) => { if (c) console.log(`  ok   ${n}: ${m}`); else { fails++; console.log(`  FAIL ${n}: ${m}`); } };

const GAMES = 110;                     // play-ins + swiss + knockouts
const certain = k => 1 - Math.pow(1 - S.BINGO[k].rate, GAMES) > 0.95;
const keys = Object.keys(S.BINGO);

// ── 1) every square has a measured rate and can actually happen ───────────
const noRate = keys.filter(k => typeof S.BINGO[k].rate !== 'number');
ok('every_square_has_a_rate', noRate.length === 0,
   noRate.length ? 'ohne rate: ' + noRate.join(', ') : `${keys.length} Felder, alle mit gemessener Rate`);
const impossible = keys.filter(k => S.BINGO[k].rate <= 0);
ok('no_impossible_square', impossible.length === 0,
   impossible.length ? 'kann nie treffen: ' + impossible.join(', ') : 'kein totes Feld im Pool');

// ── 2) the softest squares must not reach a card at all ───────────────────
// Ratio of near-certain cells is the wrong measure: restricted to the 28 least
// likely squares most are STILL >95% over 110 games, so a card is ~80% certain
// either way. What matters is that the genuinely soft end is excluded, so the
// average square on a card is rarer than the average square in the pool.
const card = S.bingoCard('event|worlds_2026|seed|m1');
const mean = ks => ks.reduce((t, k) => t + S.BINGO[k].rate, 0) / ks.length;
const onCard = mean(card.cells), inPool = mean(keys);
ok('card_drawn_from_the_hard_end', onCard < inPool,
   `Schnitt auf der Karte ${(onCard * 100).toFixed(1)}% pro Spiel, im Pool ${(inPool * 100).toFixed(1)}% - die weichsten Felder bleiben draussen`);
// BINGO_POOL keeps the 40 least likely of 45, so the 5 softest are excluded.
const softest = keys.slice().sort((a, b) => S.BINGO[b].rate - S.BINGO[a].rate).slice(0, 5);
const leaked = card.cells.filter(k => softest.includes(k));
ok('softest_excluded', leaked.length === 0,
   leaked.length ? 'auf der Karte gelandet: ' + leaked.join(', ') : 'keines der 5 haeufigsten Felder auf der Karte');

// ── 3) pacing: a line must not be likely in the first dozen games ─────────
function firstLine(cells, trials = 2500) {
  const n = 5, lines = [];
  for (let r = 0; r < n; r++) lines.push([...Array(n)].map((_, i) => r * n + i));
  for (let c = 0; c < n; c++) lines.push([...Array(n)].map((_, i) => i * n + c));
  lines.push([...Array(n)].map((_, i) => i * n + i));
  lines.push([...Array(n)].map((_, i) => i * n + (n - 1 - i)));
  let early = 0, ever = 0, sum = 0;
  for (let t = 0; t < trials; t++) {
    const hit = new Array(25).fill(false); let got = 0;
    for (let g = 1; g <= GAMES; g++) {
      for (let i = 0; i < 25; i++) if (!hit[i] && Math.random() < S.BINGO[cells[i]].rate) hit[i] = true;
      if (!got && lines.some(l => l.every(i => hit[i]))) got = g;
    }
    if (got) { ever++; sum += got; if (got <= 12) early++; }
  }
  return { early: early / trials, ever: ever / trials, avg: ever ? sum / ever : 0 };
}
let worstEarly = 0, bestEver = 1, avgs = [];
for (const m of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) {
  const r = firstLine(S.bingoCard('event|worlds_2026|seed|' + m).cells);
  worstEarly = Math.max(worstEarly, r.early);
  bestEver = Math.min(bestEver, r.ever);
  avgs.push(Math.round(r.avg));
}
ok('no_bingo_on_day_one', worstEarly <= 0.15,
   `schlimmstenfalls ${(worstEarly * 100).toFixed(0)}% Chance auf eine Linie in den ersten 12 Spielen (Grenze 15%)`);
ok('line_takes_a_while', Math.min(...avgs) >= 18,
   `erste Linie im Schnitt nach ${avgs.join('/')} Spielen`);
ok('card_still_winnable', bestEver >= 0.8,
   `mindestens ${(bestEver * 100).toFixed(0)}% der Karten kommen ueberhaupt auf eine Linie - schwer, nicht unmoeglich`);

// ── 4) a reshuffle really gives everyone a different card ─────────────────
const before = S.bingoCard('event|worlds_2026|aaa|m1').cells.join();
const after = S.bingoCard('event|worlds_2026|bbb|m1').cells.join();
ok('reshuffle_changes_cards', before !== after,
   'anderer bingoSeed -> andere Karte (der Admin-Knopf setzt genau diesen Seed neu)');

// ── 5) and the Latin-square guarantee still holds ─────────────────────────
// 'rare' is relative to the usable pool (the 12 rarest), not an absolute
// rate, so check that every line contains at least one of them.
const RANKED = Object.keys(S.BINGO).sort((a, b) => S.BINGO[a].rate - S.BINGO[b].rate);
const RARESET = new Set(RANKED.slice(0, 12));
const RARE = k => RARESET.has(k);
let bad = null;
for (const m of ['m1', 'm2', 'm3', 'm4']) {
  const c = S.bingoCard('event|worlds_2026|seed|' + m), n = c.size, lines = [];
  for (let r = 0; r < n; r++) lines.push([...Array(n)].map((_, i) => r * n + i));
  for (let col = 0; col < n; col++) lines.push([...Array(n)].map((_, i) => i * n + col));
  lines.push([...Array(n)].map((_, i) => i * n + i));
  lines.push([...Array(n)].map((_, i) => i * n + (n - 1 - i)));
  for (const l of lines) { const r = l.filter(i => RARE(c.cells[i])).length; if (r < 1) { bad = r; break; } }
  if (bad !== null) break;
}
ok('still_rare_in_every_line', bad === null,
   bad === null ? 'jede Linie hat weiterhin mindestens ein seltenes Feld' : `eine Linie hat ${bad}`);

console.log(`\n${fails ? fails + ' FAILED' : 'all bingo-pace tests passed'}`);
process.exit(fails ? 1 : 0);
