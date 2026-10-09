// The weekly lineup is the season's actual game, so the system must not play
// it for you. These tests pin two promises:
//   1. skipping a week carries LAST WEEK'S lineup, unchanged
//   2. nothing anywhere picks players by form
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

globalThis.window = globalThis;
const require = createRequire(import.meta.url);
require('../scoring.js');
const S = globalThis.LECScoring;

let fails = 0;
const ok = (n, c, m) => { if (c) console.log(`  ok   ${n}: ${m}`); else { fails++; console.log(`  FAIL ${n}: ${m}`); } };

const schedule = JSON.parse(readFileSync(new URL('../data/schedule.json', import.meta.url), 'utf8'));
const stats = JSON.parse(readFileSync(new URL('../data/stats.json', import.meta.url), 'utf8'));
const players = JSON.parse(readFileSync(new URL('../data/players.json', import.meta.url), 'utf8'));
const PIDX = new Map((players.players || []).map(p => [p.id, p]));

// a league with one manager holding 2 per role
const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
const roster = [];
const avgOf = id => {
  const rows = (stats.games || []).filter(g => g.player === id);
  if (!rows.length) return 0;
  return rows.reduce((t, g) => t + (g.k * 3 - g.d + g.a * 1.5 + g.cs * 0.02 + (g.win ? 2 : 0)), 0) / rows.length;
};
// Pick, per role, the BEST and a clearly WORSE player. The neutrality test is
// only meaningful if starting the worse one is a choice the system would
// plausibly want to "fix".
for (const r of ROLES) {
  const of = (players.players || []).filter(p => p.role === r && (stats.games || []).some(g => g.player === p.id));
  const sorted = of.slice().sort((a, b) => avgOf(b.id) - avgOf(a.id));
  roster.push(sorted[0].id, sorted[sorted.length - 1].id);
}
const league = {
  name: 'T', scoring: { kill: 3, death: -1, assist: 1.5, cs10: 0.02, win: 2 },
  roster: { slots: ROLES, perRole: 2, bench: 0 },
  lineup: { enabled: true, captain: 1.5 },
  managers: [{ id: 'm1', name: 'M1' }],
  draft: { status: 'done', completed: true, order: ['m1'], snake: true,
           picks: roster.map(p => ({ manager: 'm1', player: p, at: 1 })) },
  lineups: {},
};

const cal = S.calendar(schedule);
const keys = cal.keys.filter(k => cal.start.get(k));
const w1 = keys[0], w2 = keys[1], w3 = keys[2];
ok('calendar', !!(w1 && w2 && w3), `Wochen: ${w1}, ${w2}, ${w3}`);

// week 1: deliberately field the SECOND player of each role (never "best form")
const mine = {};
for (const r of ROLES) mine[r] = roster[ROLES.indexOf(r) * 2 + 1];
league.lineups.m1 = { [w1]: { starters: ROLES.map(r => mine[r]), captain: mine.MID, vice: mine.TOP, bench: [] } };

const l1 = S.lineupPreview(league, stats, PIDX, schedule, 'm1', w1);
ok('week1_saved_used', ROLES.every(r => l1.starters.includes(mine[r])),
   'gespeicherte Aufstellung wird genau so verwendet');

// week 2: nothing saved -> must be identical to week 1
const l2 = S.lineupPreview(league, stats, PIDX, schedule, 'm1', w2);
ok('week2_carried', l2.starters.join() === l1.starters.join() && l2.captain === l1.captain,
   `nichts gesetzt -> Vorwoche laeuft weiter (${l2.carried ? 'carried' : 'nicht markiert'})`);
ok('week2_marked_carried', l2.carried === true, 'als uebernommen markiert, nicht als "automatisch"');

// week 3 too - no silent re-optimisation later on
const l3 = S.lineupPreview(league, stats, PIDX, schedule, 'm1', w3);
ok('week3_still_carried', l3.starters.join() === l1.starters.join(),
   'auch zwei Wochen spaeter unveraendert - niemand optimiert fuer dich');

// the carried lineup must NOT be the best-form one, otherwise the test proves
// nothing. Check at least one started player has a worse average than his
// benched team-mate of the same role.
const avg = id => {
  const rows = (stats.games || []).filter(g => g.player === id);
  if (!rows.length) return 0;
  return rows.reduce((t, g) => t + S.gamePoints(g, league.scoring), 0) / rows.length;
};
let worseStarted = 0;
for (const r of ROLES) {
  const a = roster[ROLES.indexOf(r) * 2], b = roster[ROLES.indexOf(r) * 2 + 1];
  if (l2.starters.includes(b) && avg(b) < avg(a)) worseStarted++;
}
ok('no_form_optimisation', worseStarted > 0,
   `${worseStarted} von 5 Startern haben einen schlechteren Schnitt als ihr Ersatz - es wurde nichts "verbessert"`);

// a brand new manager (never set anything) still gets a full five
const fresh = JSON.parse(JSON.stringify(league));
fresh.lineups = {};
const l0 = S.lineupPreview(fresh, stats, PIDX, schedule, 'm1', w2);
ok('fresh_manager_gets_five', l0.starters.length === ROLES.length,
   `ohne jede Eingabe trotzdem ${l0.starters.length} Starter (sonst 0 Punkte)`);

// captain/vice must come from the saved lineup, not from form
ok('captain_from_saved', l2.captain === mine.MID && l2.vice === mine.TOP,
   'Kapitaen und Vize bleiben die gewaehlten, nicht die formstaerksten');

console.log(`\n${fails ? fails + ' FAILED' : 'all lineup-neutrality tests passed'}`);
process.exit(fails ? 1 : 0);
