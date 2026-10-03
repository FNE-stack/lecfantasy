// ═══════════════════════════════════════════════════════════════════════════
// Test mode: the admin plays the whole thing through with a few bots.
//
// Start takes a backup, adds bot managers and opens transfers; ending restores
// that backup, so afterwards everything is exactly as before. Bots draft the
// moment they are on the clock, tip every open pick'em, answer trade offers
// (accept when they do not lose more than 10 % average) and sometimes reply in
// the chat. league.testMode = { on, startedAt, backupId, bots:[ids] }
// ═══════════════════════════════════════════════════════════════════════════
import { S, HttpError, readLeagueFresh, writeLeague, publicData, playerIndex, seasonPoints } from './store.js';
import { backupNow, backupRestore, backupGet } from './backup.js';
import { tradeAction } from './draft.js';
import { chatPost } from './extras.js';

const BOT_NAMES = ['Bot Anna', 'Bot Ben', 'Bot Chris', 'Bot Dana', 'Bot Emil'];
const pickOne = list => list[Math.floor(Math.random() * list.length)];
const isBot = (league, id) => !!(league.testMode && league.testMode.on && (league.testMode.bots || []).includes(id));

export async function testStart(env, body) {
  const { data } = await readLeagueFresh(env);
  if (data.testMode && data.testMode.on) throw new HttpError(409, 'Der Testmodus läuft schon.');
  if (S.draftStatus(data) !== 'lobby') throw new HttpError(409, 'Testmodus geht nur vor dem Draft (Status Anmeldung) — sonst erst den Draft zurücksetzen.');
  const n = Math.max(1, Math.min(5, Number(body.bots) || 3));
  const bk = await backupNow(env, 'vor dem Testmodus');
  const bots = [];
  await writeLeague(env, league => {
    for (const name of BOT_NAMES.filter(x => !(league.managers || []).some(m => m.name === x)).slice(0, n)) {
      const id = 'm' + [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
      league.managers = (league.managers || []).concat({ id, name, joined: new Date().toISOString() });
      league.draft.order = (league.draft.order || []).concat(id);
      bots.push(id);
    }
    league.tradeRules = Object.assign({}, league.tradeRules || {}, { enabled: true, mode: 'always' });
    league.testMode = { on: true, startedAt: new Date().toISOString(), backupId: bk.id, bots };
    return league;
  }, `test: Testmodus an (${n} Bots)`);
  return { message: `Testmodus an: ${bots.length} Bots sind dabei. Vorher-Stand gesichert als Backup ${bk.id}.` };
}

export async function testEnd(env) {
  const { data } = await readLeagueFresh(env);
  const tm = data.testMode;
  if (!tm || !tm.on) throw new HttpError(409, 'Der Testmodus läuft gerade nicht.');
  // real people who joined during the test keep their account (id, name,
  // password, sessions); only the bots and the test data go
  const before = await backupGet(env, tm.backupId);
  const known = new Set(((before.league || {}).managers || []).map(m => m.id));
  const keep = (data.managers || []).filter(m => !(tm.bots || []).includes(m.id) && !known.has(m.id));
  await backupRestore(env, { id: tm.backupId });
  if (keep.length) {
    await writeLeague(env, l => {
      for (const m of keep) if (!(l.managers || []).some(x => x.id === m.id)) {
        l.managers = (l.managers || []).concat({ id: m.id, name: m.name, joined: m.joined });
        l.draft.order = (l.draft.order || []).concat(m.id);
      }
      return l;
    }, `test: Konten bleiben (${keep.map(m => m.name).join(', ')})`);
  }
  return { message: 'Testmodus beendet — alles ist wieder wie vor dem Test.' + (keep.length ? ` Dabei bleiben: ${keep.map(m => m.name).join(', ')} (mit Passwort).` : '') };
}

// Bots on the clock pick at once, in one write: from their three best legal
// players by season points (a little variety, still sensible).
export async function runBots(env, league) {
  if (!league || !league.testMode || !league.testMode.on || S.draftStatus(league) !== 'live') return null;
  if (!isBot(league, S.currentPicker(league))) return null;
  const players = await playerIndex(env);
  const pts = await seasonPoints(env, league);
  const res = await writeLeague(env, l => {
    let n = 0;
    while (S.draftStatus(l) === 'live' && isBot(l, S.currentPicker(l)) && n < 200) {
      const bot = S.currentPicker(l), level = S.relaxLevel(l, players, bot);
      const legal = [...players.keys()].filter(id => !S.pickError(l, players, bot, id, level)).sort((a, b) => (pts.get(b) || 0) - (pts.get(a) || 0));
      if (!legal.length) break;
      l.draft.picks.push({ manager: bot, player: pickOne(legal.slice(0, 3)), at: new Date().toISOString(), by: 'bot' });
      if (S.currentPicker(l) === null && l.draft.picks.length >= l.draft.order.length * S.rosterSize(l)) { l.draft.status = 'done'; l.draft.completed = true; }
      n++;
    }
    return n ? l : null;
  }, l => `test: Bots picken (${l.draft.picks.length} Picks)`);
  return res.changed ? res.league : null;
}

// Every open pick'em: bots without tips tip now.
export async function botPickems(env, league) {
  if (!league || !league.testMode || !league.testMode.on) return 0;
  const schedule = await publicData(env, 'schedule.json', 60);
  const [players, champs] = await Promise.all([playerIndex(env), publicData(env, 'champions.json', 3600)]);
  const teams = [...new Set([...players.values()].map(p => p.team))];
  const champIds = Object.keys((champs && champs.names) || {});
  const top = [...players.keys()].slice(0, 40);
  let n = 0;
  for (const [split, pe] of Object.entries(league.pickems || {})) {
    if (!pe || pe.revealed) continue;
    const lock = S.pickemLock(league, schedule, split);
    if (lock && Date.now() >= Date.parse(lock)) continue;
    for (const bot of league.testMode.bots || []) {
      if (await env.LEAGUE.get(`pick:${split}:${bot}`)) continue;
      const picks = {};
      for (const q of pe.questions || []) {
        const kind = (S.PICKEM_TYPES[q.type] || {}).kind;
        picks[q.id] = kind === 'team' ? pickOne(teams) : kind === 'player' ? pickOne(top) : kind === 'champion' ? pickOne(champIds.length ? champIds : ['Ahri'])
          : String(30 + Math.floor(Math.random() * 25));
      }
      await env.LEAGUE.put(`pick:${split}:${bot}`, JSON.stringify(picks));
      n++;
    }
  }
  return n;
}

// A trade offer to a bot is answered at once.
export async function botTrade(env, trade) {
  const { data: league } = await readLeagueFresh(env);
  if (!trade || !isBot(league, trade.to) || trade.status !== 'proposed') return null;
  const pts = await seasonPoints(env, league);
  const sum = ids => ids.reduce((t, id) => t + (pts.get(id) || 0), 0);
  const accept = sum(trade.give) >= 0.9 * sum(trade.get);
  try { await tradeAction(env, trade.to, { action: 'respond', id: trade.id, accept }); } catch (e) { return null; }
  return accept;
}

const LINES = ['Haha, abwarten 😄', 'Mein Team ist eh das beste.', 'Diese Woche hast du keine Chance gegen mich.', 'Trade gefällig? 👀',
  'Hast du meinen Kapitän gesehen? 🔥', 'gg', 'Wer hat bitte so gedraftet 😂', 'Ich sag nur: Playoffs.'];
// Now and then a bot answers a chat line (test mode only).
export async function botChat(env, fromId) {
  const { data: league } = await readLeagueFresh(env);
  if (!league.testMode || !league.testMode.on || isBot(league, fromId) || Math.random() < 0.4) return null;
  const bot = pickOne(league.testMode.bots || []);
  return bot ? chatPost(env, bot, pickOne(LINES)).catch(() => null) : null;
}

// Events: every bot builds a legal team for the open stage (best value it can
// afford, a bit of chance) and tips the event pick'em.
export async function botEvents(env, league) {
  if (!league || !league.testMode || !league.testMode.on) return 0;
  const { eventData, eventPickemLock } = await import('./events.js');
  let n = 0;
  for (const [slug, ev] of Object.entries(league.events || {})) {
    let d;
    try { d = await eventData(env, slug, ev); } catch (e) { continue; }
    const stage = S.eventOpenStage(d);
    const roles = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
    for (const bot of league.testMode.bots || []) {
      if (stage !== null && !(await env.LEAGUE.get(`evt:${slug}:${stage}:${bot}`))) {
        for (let tries = 0; tries < 200; tries++) {
          const sel = { players: roles.map(r => pickOne(d.players.filter(p => p.role === r)).id) };
          sel.captain = pickOne(sel.players);
          if (!S.eventTeamError(ev, d, sel)) { await env.LEAGUE.put(`evt:${slug}:${stage}:${bot}`, JSON.stringify(sel)); n++; break; }
        }
      }
      const pe = ev.pickem, lock = eventPickemLock(ev, d);
      if (pe && !pe.revealed && !(lock && Date.now() >= lock) && !(await env.LEAGUE.get(`evp:${slug}:${bot}`))) {
        const regions = [...new Set(d.teams.map(t => t.league).filter(Boolean))];
        const picks = {};
        for (const q of pe.questions || []) {
          const kind = (S.EVENT_TYPES[q.type] || {}).kind;
          picks[q.id] = kind === 'team' ? pickOne(d.teams).code : kind === 'player' ? pickOne(d.players).id : kind === 'region' ? pickOne(regions)
            : kind === 'champion' ? pickOne([...new Set(d.games.map(g => g.champ))].concat('Ahri')) : String(30 + Math.floor(Math.random() * 25));
        }
        await env.LEAGUE.put(`evp:${slug}:${bot}`, JSON.stringify(picks)); n++;
      }
    }
  }
  return n;
}
