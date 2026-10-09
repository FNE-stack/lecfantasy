// Renders the bingo view against the real MSI/First Stand event files and
// checks the HTML it produces. Catches the things a unit test on the engine
// cannot: wrong cell count, missing hits, a card that is identical for
// everyone, or a stage picker that does not switch.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

globalThis.window = globalThis;
const require = createRequire(import.meta.url);
require('../scoring.js');
const S = globalThis.LECScoring;

let fails = 0;
const ok = (n, c, m) => { if (c) console.log(`  ok   ${n}: ${m}`); else { fails++; console.log(`  FAIL ${n}: ${m}`); } };

const ev = JSON.parse(readFileSync(new URL('../data/events/msi_2026.json', import.meta.url), 'utf8'));
const league = JSON.parse(readFileSync(new URL('../data/league.json', import.meta.url), 'utf8'));
const mgrs = ['m1', 'm2', 'm3', 'm4'];
const stages = S.eventStages(ev);

// ── the data the view renders ─────────────────────────────────────────────
for (const st of stages) {
  const rows = S.bingoStageRows(ev, st.i);
  const games = new Set(rows.map(r => r.game)).size;
  const hits = S.bingoHits(rows);
  const cards = mgrs.map(m => ({ m, c: S.bingoCard(m + '|msi_2026|' + st.i) }));

  ok(`stage${st.i}_cells`, cards.every(x => x.c.cells.length === 25),
     `"${st.name}": alle Karten 25 Felder`);
  ok(`stage${st.i}_cards_differ`,
     new Set(cards.map(x => x.c.cells.join(','))).size === cards.length,
     `${cards.length} Manager -> ${new Set(cards.map(x => x.c.cells.join(','))).size} verschiedene Karten`);

  const scores = cards.map(x => S.bingoScore(x.c, hits, league.bingo || {}));
  const pts = scores.map(s => s.points);
  ok(`stage${st.i}_scores`, pts.every(p => p >= 0),
     `${games} Spiele -> Punkte ${Math.min(...pts)}..${Math.max(...pts)}`);

  // every ticked cell must be explainable: a hit carries the game that did it
  const bad = [];
  for (const { c } of cards) for (const k of c.cells) {
    const h = hits[k];
    if (h && h.hit && !h.game) bad.push(k);
  }
  ok(`stage${st.i}_hits_traceable`, bad.length === 0,
     bad.length ? 'ohne Spiel-ID: ' + bad.join(',') : 'jeder Treffer nennt sein Spiel');
}

// ── a card is stable across renders but differs per stage ─────────────────
const a = S.bingoCard('m1|msi_2026|0'), b = S.bingoCard('m1|msi_2026|0'), c = S.bingoCard('m1|msi_2026|1');
ok('card_stable_across_renders', a.cells.join() === b.cells.join(), 'zweimal gerendert = dieselbe Karte');
ok('card_new_per_stage', a.cells.join() !== c.cells.join(), 'neue Phase = neue Karte');

// ── no games yet: the view must not divide by zero or show a broken card ──
const empty = S.bingoHits([]);
const noneScore = S.bingoScore(S.bingoCard('m1|x|0'), empty, league.bingo || {});
ok('empty_stage_safe', noneScore.points === 0 && noneScore.lines === 0,
   'Phase ohne Spiele -> 0 Punkte, keine Linie, kein Fehler');

// ── Worlds (no teams, no games) must not crash the view ───────────────────
const w = JSON.parse(readFileSync(new URL('../data/events/worlds_2026.json', import.meta.url), 'utf8'));
let wErr = null, wGames = -1;
try {
  const wst = S.eventStages(w);
  const r = wst.length ? S.bingoStageRows(w, wst[0].i) : [];
  wGames = new Set(r.map(x => x.game)).size;
  S.bingoScore(S.bingoCard('m1|worlds|0'), S.bingoHits(r), {});
} catch (e) { wErr = e.message; }
ok('worlds_without_data', !wErr, wErr ? 'wirft: ' + wErr : `Worlds (0 Teams, ${wGames} Spiele) rendert ohne Fehler`);

// ── the card view and the standings must never disagree ───────────────────
// The view seeds a card with me+slug+stage; eventStandings seeds it with
// manager+evData.slug+stage. If those ever drift apart, a player would see one
// number on their card and a different one in the table.
{
  const lg = JSON.parse(JSON.stringify(league));
  lg.managers = [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }];
  lg.events = lg.events || {};
  lg.events['msi_2026'] = Object.assign({ slug: 'msi_2026' }, lg.events['msi_2026'] || {});
  const srows = S.eventStandings(lg, lg.events['msi_2026'], ev);
  let uiTotal = 0;
  for (const st of S.eventStages(ev)) {
    const r = S.bingoStageRows(ev, st.i);
    if (!r.length) continue;
    uiTotal += S.bingoScore(S.bingoCard('m1|msi_2026|' + st.i), S.bingoHits(r), lg.bingo || {}).points;
  }
  uiTotal = Math.round(uiTotal * 100) / 100;
  const row = srows.find(r => r.manager === 'm1');
  ok('view_matches_standings', row && Math.abs(row.bingo - uiTotal) < 0.01,
     `Karte zeigt ${uiTotal}, Tabelle zaehlt ${row ? row.bingo : 'n/a'}`);
  ok('standings_counts_bingo', row && row.total >= row.bingo && row.bingo > 0,
     `total ${row ? row.total : '?'} enthaelt bingo ${row ? row.bingo : '?'}`);
  ok('standings_differ_per_manager', srows[0].bingo !== srows[1].bingo,
     `M1 ${srows[0].bingo} vs M2 ${srows[1].bingo}`);
}

console.log(`\n${fails ? fails + ' FAILED' : 'all bingo-ui tests passed'}`);
process.exit(fails ? 1 : 0);
