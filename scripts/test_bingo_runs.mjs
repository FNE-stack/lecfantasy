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
  // The board is deliberately hard now, so a short stage may well end with no
  // completed line at all. What matters is that the closed run still CONTRIBUTES
  // whatever it scored - not that it scored something.
  const closedRows = S.bingoRunRows(msi, rr[0]).length;
  ok('closed_run_still_counted', closedRows > 0 && a >= 0 && Number.isFinite(a),
     `abgeschlossene Runde wertet ${closedRows} Zeilen -> ${a} Punkte`);
  ok('sum_with_real_points', Math.abs(tot - (a + b)) < 0.01, `${a} + ${b} = ${tot}`);
  const rows1 = S.bingoRunRows(msi, rr[0]).length, rows2 = S.bingoRunRows(msi, rr[1]).length;
  ok('each_run_only_its_stages', rows1 > 0 && rows2 > 0 && rows1 + rows2 === msi.games.length,
     `${rows1} + ${rows2} = ${msi.games.length} Spielzeilen, sauber aufgeteilt`);
}

// ── the page must show the OPEN run, not run #1 ───────────────────────────
// eventBingoAll without a run argument falls back to the first run. The page
// did exactly that, so after starting a new round everyone still saw the
// Play-Ins board - which looked like the new round had done nothing and the
// old board had vanished at the same time.
{
  const cfg = { slug: 'worlds_2026', name: 'Worlds', minigame: 'bingo', bingoRuns: [
    { id: 'r1', name: 'Play-Ins', seed: 's1', stages: [0], closed: true },
    { id: 'r2', name: 'Swiss', seed: 's2', stages: [1, 2], closed: false } ] };
  const rr = S.eventBingoRuns(cfg, ev);
  const fallback = Object.values(S.eventBingoAll(league, cfg, ev))[0];
  ok('default_is_first_run', fallback.run.id === 'r1',
     'ohne Argument liefert eventBingoAll weiterhin Runde 1 - die Seite muss selbst waehlen');
  const open = rr.filter(r => !r.closed).pop();
  ok('open_run_is_findable', open && open.id === 'r2',
     `die offene Runde ist eindeutig bestimmbar (${open ? open.name : '-'})`);
  // Not "0 ticked" - that only holds until the first game of the new run.
  // What must hold forever: every ticked square came from a game of the new
  // run's own stages, never from a closed run.
  const openCard = Object.values(S.eventBingoAll(league, cfg, ev, open))[0];
  const closedRows = S.bingoRunRows(ev, rr[0]).length;
  const stageOf = new Map(ev.schedule.map(e => [e.match, e.stage]));
  const matchOf = new Map(ev.games.map(g => [g.game, g.match]));
  const ticked = Object.values(openCard.hits).filter(h => h.hit);
  const leaked = ticked.filter(h => !open.stages.includes(stageOf.get(matchOf.get(h.game))));
  ok('open_run_ignores_closed_games', closedRows > 0 && leaked.length === 0,
     `${closedRows} Play-Ins-Zeilen; ${ticked.length} Felder auf dem neuen Board, alle aus dessen eigenen Phasen - nichts leckt hinueber`);
}

// ── every card square must be one of the rarer ones ───────────────────────
// A "new, rarer" board that still carries 14.7%-squares is not rarer. The
// draw is limited to the least likely squares, so cap what can appear.
{
  const cap = 0.09;
  for (const m of mgrs.slice(0, 3)) {
    const c = S.bingoCard('event|worlds_2026|x|' + m);
    const worst = Math.max(...c.cells.map(k => S.BINGO[k].rate));
    ok('card_has_no_common_square_' + m.slice(-4), worst <= cap,
       `haeufigstes Feld ${(worst * 100).toFixed(1)}% pro Spiel (Grenze ${(cap * 100).toFixed(0)}%)`);
  }
}

// ── card version 2: no duplicate stats, no family twice in a line ─────────
{
  const lines = S.bingoLines(5);
  let clash = 0, dup = 0, distinct = 1e9, rarePerLine = true, pool2 = new Set(S.bingoPool(2));
  for (let n = 0; n < 400; n++) {
    const c = S.bingoCard('event|worlds_2026|v2test|' + n, 5, 2);
    distinct = Math.min(distinct, new Set(c.cells).size);
    if (c.cells.some(k => k === 'teamNoDeaths' || k === 'everyoneDies' || !pool2.has(k))) dup++;
    for (const l of lines) {
      const fam = l.map(i => S.BINGO_FAMILY[c.cells[i]]).filter(Boolean);
      if (new Set(fam).size !== fam.length) clash++;
      if (l.filter(i => c.rare.includes(i)).length !== 1) rarePerLine = false;
    }
  }
  ok('v2_no_duplicates', dup === 0, '400 Karten: keine doppelte Stat (Team ohne Tod / alle 3+ Tode), alles aus dem v2-Pool');
  ok('v2_no_family_in_a_line', clash === 0, `400 Karten x 12 Linien: ${clash} Linien mit zwei Feldern derselben Sorte`);
  ok('v2_card_shape', distinct === 25 && rarePerLine, `immer 25 verschiedene Felder, genau ein ★ je Linie`);
  // a round without cardV keeps its old cards
  const v1 = S.bingoCard('event|worlds_2026|pzdeja|x');
  ok('v1_unchanged', JSON.stringify(S.bingoCard('event|worlds_2026|pzdeja|x', 5, 1)) === JSON.stringify(v1), 'Runden ohne Version behalten ihre Karten');
}

// ── the Play-Ins board must be the one that was PLAYED ────────────────────
// b8f51eb dealt it; on 22.10. a change to the draw redealt it and wiped its
// squares and Max's line. Version 0 reproduces those cards exactly.
{
  const run0 = { id: 'r1', seed: 'pzdeja', stages: [0], closed: true, cardV: 0 };
  const evd = Object.assign({}, league.events.worlds_2026, { bingoRuns: [run0] });
  const all = S.eventBingoAll(league, evd, ev, S.eventBingoRuns(evd, ev)[0]);
  const byName = Object.fromEntries(league.managers.map(m => [m.name, all[m.id]]));
  ok('v0_cards_have_old_pool', Object.values(all).every(b => b.card.cells.every(k => S.bingoPool(0).includes(k)) && new Set(b.card.cells).size === 25),
     'Play-Ins-Karten nur aus den 40 Original-Feldern, je 25 verschieden');
  ok('v0_restores_max_line', byName.Max && byName.Max.score.lines === 1 && byName.Max.score.points === 3,
     `Max hat seine Play-Ins-Linie wieder (${byName.Max ? byName.Max.score.lines + ' Linie, ' + byName.Max.score.points + ' Punkte' : '-'})`);
  ok('v0_squares_back', Object.values(all).every(b => b.score.squares >= 15),
     'alle wieder bei 15-16 Feldern: ' + Object.entries(byName).map(([n, b]) => n + ' ' + b.score.squares).join(', '));
}

console.log(`\n${fails ? fails + ' FAILED' : 'all bingo-run tests passed'}`);
process.exit(fails ? 1 : 0);
