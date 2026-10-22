// Bingo over several runs. Worlds runs a month across three very different
// phases; one board for all of it means the Play-Ins decide the whole thing.
// A new run closes the current board - its points stay - and starts a fresh
// one from a chosen stage onwards.
//
// The thing that must never break: the new board may NOT see games from the
// closed run, or it would open half-ticked from results that already paid out.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

globalThis.window = globalThis;
const require = createRequire(import.meta.url);
require('../scoring.js');
const S = globalThis.LECScoring;

let fails = 0;
const ok = (n, c, m) => { if (c) console.log(`  ok   ${n}: ${m}`); else { fails++; console.log(`  FAIL ${n}: ${m}`); } };

const league = JSON.parse(readFileSync(new URL('../data/league.json', import.meta.url), 'utf8'));
const ev = JSON.parse(readFileSync(new URL('../data/events/worlds_2026.json', import.meta.url), 'utf8'));
const mgrs = league.managers.map(m => m.id);

// ── without runs configured: one implicit run over everything ─────────────
const plain = { slug: 'worlds_2026', name: 'Worlds', minigame: 'bingo', bingoSeed: 'abc' };
const one = S.eventBingoRuns(plain, ev);
ok('implicit_single_run', one.length === 1 && one[0].stages === null,
   'ohne Konfiguration genau eine Runde ueber das ganze Event');

// ── two runs: Play-Ins closed, main event fresh ───────────────────────────
const two = {
  slug: 'worlds_2026', name: 'Worlds', minigame: 'bingo',
  bingoRuns: [
    { id: 'r1', name: 'Play-Ins', seed: 'seed1', stages: [0], closed: true },
    { id: 'r2', name: 'Swiss + Knockouts', seed: 'seed2', stages: [1, 2], closed: false },
  ],
};
const runs = S.eventBingoRuns(two, ev);
ok('two_runs', runs.length === 2 && runs[0].closed && !runs[1].closed,
   `${runs.map(r => r.name + (r.closed ? ' (zu)' : ' (offen)')).join(', ')}`);

// the slices must not overlap
const r1rows = S.bingoRunRows(ev, runs[0]);
const r2rows = S.bingoRunRows(ev, runs[1]);
const r1games = new Set(r1rows.map(g => g.game)), r2games = new Set(r2rows.map(g => g.game));
const overlap = [...r1games].filter(g => r2games.has(g));
ok('runs_do_not_overlap', overlap.length === 0,
   `Runde 1: ${r1games.size} Spiele, Runde 2: ${r2games.size} - keine Ueberschneidung`);
ok('closed_run_has_the_played_games', r1games.size > 0,
   `die abgeschlossene Play-Ins-Runde haelt ihre ${r1games.size} Spiele`);

// ── THE POINT: the new board starts empty ─────────────────────────────────
const fresh = S.eventBingoAll(league, two, ev, runs[1]);
const ticked = Object.values(fresh)[0].hits;
const anyHit = Object.values(ticked).filter(h => h.hit).length;
ok('new_board_starts_empty', r2games.size === 0 ? anyHit === 0 : true,
   r2games.size === 0
     ? 'Swiss/Knockouts noch nicht gespielt -> neue Karte komplett leer'
     : `${anyHit} Felder aus ${r2games.size} schon gespielten Spielen der neuen Phase`);

// and it must NOT be the same board as the closed one
const oldCard = S.eventBingo(league, two, ev, mgrs[0], null, runs[0]).card.cells.join();
const newCard = S.eventBingo(league, two, ev, mgrs[0], null, runs[1]).card.cells.join();
ok('new_board_is_a_new_card', oldCard !== newCard,
   'andere Runde = andere Karte (eigener Seed je Runde)');

// ── the closed run keeps paying ───────────────────────────────────────────
for (const m of mgrs.slice(0, 1)) {
  const closedPts = S.eventBingo(league, two, ev, m, null, runs[0]).score.points;
  const openPts = S.eventBingo(league, two, ev, m, null, runs[1]).score.points;
  const total = S.eventBingoTotal(league, two, ev, m);
  ok('total_sums_all_runs', Math.abs(total - (closedPts + openPts)) < 0.01,
     `abgeschlossen ${closedPts} + laufend ${openPts} = ${total}`);
}

// ── standings use the total, not just the open run ────────────────────────
const lg = JSON.parse(JSON.stringify(league));
lg.events = { worlds_2026: two };
const rows = S.eventStandings(lg, two, ev);
const row = rows.find(r => r.manager === mgrs[0]);
ok('standings_use_total', row && Math.abs(row.bingo - S.eventBingoTotal(lg, two, ev, mgrs[0])) < 0.01,
   `Tabelle zeigt ${row ? row.bingo : '?'} (Summe beider Runden)`);

// ── with points on both sides: MSI is finished, so both runs really score ──
// Worlds has only played the Play-Ins, so above both runs score 0 and "0+0=0"
// proves nothing. MSI is a completed event with two stages, which gives the
// sum real numbers to add up.
{
  const msi = JSON.parse(readFileSync(new URL('../data/events/msi_2026.json', import.meta.url), 'utf8'));
  const cfg = { slug: 'msi_2026', name: 'MSI', minigame: 'bingo', bingoRuns: [
    { id: 'r1', name: 'Play-Ins', seed: 's1', stages: [0], closed: true },
    { id: 'r2', name: 'KO', seed: 's2', stages: [1], closed: false } ] };
  const rr = S.eventBingoRuns(cfg, msi), m = mgrs[0];
  const a = S.eventBingo(league, cfg, msi, m, null, rr[0]).score.points;
  const b = S.eventBingo(league, cfg, msi, m, null, rr[1]).score.points;
  const tot = S.eventBingoTotal(league, cfg, msi, m);
  ok('closed_run_keeps_its_points', a > 0,
     `abgeschlossene Runde traegt ${a} Punkte bei (nicht 0)`);
  ok('sum_with_real_points', Math.abs(tot - (a + b)) < 0.01, `${a} + ${b} = ${tot}`);
  const rows1 = S.bingoRunRows(msi, rr[0]).length, rows2 = S.bingoRunRows(msi, rr[1]).length;
  ok('each_run_only_its_stages', rows1 > 0 && rows2 > 0 && rows1 + rows2 === msi.games.length,
     `${rows1} + ${rows2} = ${msi.games.length} Spielzeilen, sauber aufgeteilt`);
}

console.log(`\n${fails ? fails + ' FAILED' : 'all bingo-run tests passed'}`);
process.exit(fails ? 1 : 0);
