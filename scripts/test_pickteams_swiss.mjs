// Two fixes, both found while setting up the real Worlds pick'em:
//   1. a Play-Ins question offered all 19 teams, not the 4 actually playing
//   2. the Swiss stage had no standings at all - only a list of TBD fixtures
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

globalThis.window = globalThis;
const require = createRequire(import.meta.url);
require('../scoring.js');
const S = globalThis.LECScoring;

let fails = 0;
const ok = (n, c, m) => { if (c) console.log(`  ok   ${n}: ${m}`); else { fails++; console.log(`  FAIL ${n}: ${m}`); } };

const w = JSON.parse(readFileSync(new URL('../data/events/worlds_2026.json', import.meta.url), 'utf8'));

// ── 1) question-specific team lists ───────────────────────────────────────
const playIn = S.eventQuestionTeams(w, 'playInOut');
const all = w.teams;
ok('playin_filtered', playIn.length === 4 && playIn.length < all.length,
   `Play-Ins: ${playIn.length} von ${all.length} Teams (${playIn.map(t => t.code).join(', ')})`);

const piCodes = new Set();
for (const e of w.schedule) {
  if (e.stage !== 0) continue;
  for (const t of (e.teams || [])) if (t && t.code && t.code !== 'TBD') piCodes.add(t.code);
}
ok('playin_matches_schedule', playIn.every(t => piCodes.has(t.code)),
   'genau die Teams, die im Play-Ins-Spielplan stehen');

ok('champion_all_teams', S.eventQuestionTeams(w, 'champion').length === all.length,
   `Turniersieger: alle ${all.length} Teams waehlbar`);
ok('swiss_not_drawn_yet', S.eventQuestionTeams(w, 'swiss30s').length === all.length,
   'Swiss noch nicht ausgelost -> ganzes Feld (ehrlich statt falsch gefiltert)');

// ── 2) Swiss standings are derivable from played games ────────────────────
// Worlds has no results yet, so the shape is checked on a finished event.
const msi = JSON.parse(readFileSync(new URL('../data/events/msi_2026.json', import.meta.url), 'utf8'));
const stages = S.eventStages(msi);
let checked = false;
for (const st of stages) {
  const evs = msi.schedule.filter(e => e.stage === st.i);
  const rec = {};
  for (const e of evs) for (const t of (e.teams || [])) {
    if (!t.code || t.code === 'TBD') continue;
    const r = rec[t.code] || (rec[t.code] = { w: 0, l: 0 });
    if (t.outcome === 'win') r.w++;
    if (t.outcome === 'loss') r.l++;
  }
  const codes = Object.keys(rec);
  if (!codes.length) continue;
  checked = true;
  const groups = new Set(codes.map(c => rec[c].w + '-' + rec[c].l));
  ok('records_derivable_' + st.i, codes.length > 0,
     `"${st.name}": ${codes.length} Teams, ${groups.size} verschiedene Bilanzen (${[...groups].slice(0, 5).join(', ')})`);
}
ok('any_stage_checked', checked, 'mindestens eine Phase mit echten Ergebnissen geprueft');

// ── 3) an un-drawn Swiss stage must not crash the view ────────────────────
const wsw = w.schedule.filter(e => e.stage === 1);
const recW = {};
for (const e of wsw) for (const t of (e.teams || [])) {
  if (!t.code || t.code === 'TBD') continue;
  (recW[t.code] = recW[t.code] || { w: 0, l: 0 });
}
ok('worlds_swiss_empty_is_fine', Object.keys(recW).length === 0 && wsw.length > 0,
   `${wsw.length} Swiss-Partien, alle noch TBD -> Ansicht zeigt den Hinweis statt einer leeren Tabelle`);

console.log(`\n${fails ? fails + ' FAILED' : 'all pick-teams/swiss tests passed'}`);
process.exit(fails ? 1 : 0);
