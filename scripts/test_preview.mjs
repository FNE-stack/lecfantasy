// Preview mode must (a) render every stage and (b) never write anything.
// Run: node scripts/test_preview.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

globalThis.window = globalThis;
globalThis.document = {
  body: { classList: { add() {}, remove() {} }, appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ classList: { add() {}, remove() {} }, querySelector: () => ({ set onchange(v) {}, set onclick(v) {} }), remove() {} }),
  addEventListener() {},
};
const require = createRequire(import.meta.url);
require('../scoring.js');
require('../preview.js');
const S = globalThis.LECScoring, P = globalThis.LECPreview;

const league = JSON.parse(readFileSync(new URL('../data/league.json', import.meta.url), 'utf8'));
const players = JSON.parse(readFileSync(new URL('../data/players.json', import.meta.url), 'utf8'));

let fails = 0;
const ok = (n, c, m) => { if (c) console.log(`  ok   ${n}: ${m}`); else { fails++; console.log(`  FAIL ${n}: ${m}`); } };

// ── 1) every scenario builds a league the scoring engine accepts ──────────
const built = [];
for (const sc of P.SCENARIOS) {
  P.on(sc.id, league, players);
  const lg = P.league();
  let status = null, standings = null, err = null;
  try {
    status = S.draftStatus(lg);
    standings = S.standings(lg, { games: [] }, new Map());
  } catch (e) { err = e.message; }
  built.push({ sc, lg, status, standings, err });
  ok('builds_' + sc.id, !err && lg && Array.isArray(lg.managers),
     err ? 'threw: ' + err : `${lg.managers.length} Manager, status=${status}, ${lg.draft.picks.length} Picks`);
}
P.off();

// ── 2) the draft scenarios actually differ ────────────────────────────────
const byId = Object.fromEntries(built.map(b => [b.sc.id, b]));
ok('lobby_is_empty', byId.lobby.lg.draft.picks.length === 0 && byId.lobby.status === 'lobby',
   'Anmeldung: keine Picks');
ok('draft_live_partial', byId.draft_live.lg.draft.picks.length > 0 && !byId.draft_live.lg.draft.completed,
   `Draft laeuft: ${byId.draft_live.lg.draft.picks.length} Picks, nicht fertig`);
ok('draft_done_full', byId.draft_done.lg.draft.completed && byId.draft_done.lg.draft.picks.length > byId.draft_live.lg.draft.picks.length,
   `Draft fertig: ${byId.draft_done.lg.draft.picks.length} Picks, completed`);

// ── 3) no duplicate players inside one previewed draft ────────────────────
for (const id of ['draft_live', 'draft_done', 'season_mid']) {
  const picks = byId[id].lg.draft.picks.map(p => p.player);
  ok('no_dupe_picks_' + id, new Set(picks).size === picks.length,
     `${picks.length} Picks, ${new Set(picks).size} verschiedene Spieler`);
}

// ── 4) THE IMPORTANT ONE: the real league is never mutated ────────────────
const before = JSON.stringify(league);
for (const sc of P.SCENARIOS) { P.on(sc.id, league, players); P.league().managers.push({ id: 'x', name: 'x' }); }
P.off();
ok('real_league_untouched', JSON.stringify(league) === before,
   'nach allen Szenarien (inkl. Mutation der Kopie) ist data/league.json unveraendert');

// ── 5) guard blocks writes while preview is on ────────────────────────────
let called = 0;
const realWrite = () => { called++; return Promise.resolve('WROTE'); };
const guarded = P.guard(realWrite);
P.on('draft_live', league, players);
const r1 = await guarded();
P.off();
const r2 = await guarded();
ok('guard_blocks_while_on', called === 1 && r1 && r1.preview === true && r2 === 'WROTE',
   `in der Vorschau geblockt (${r1 && r1.preview ? 'preview:true' : '?'}), danach wieder erlaubt`);

// ── 6) off() really restores ──────────────────────────────────────────────
ok('off_clears', !P.isOn() && P.league() === null, 'beendet -> kein Preview-Objekt mehr');

console.log(`\n${fails ? fails + ' FAILED' : 'all preview tests passed'}`);
process.exit(fails ? 1 : 0);
