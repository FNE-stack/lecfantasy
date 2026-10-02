// ═══════════════════════════════════════════════════════════════════════════
// League chat, lineup reminder, weekly recap push, hall of fame.
//
// Chat lives in KV (one list, newest last), not in league.json: a chat line
// should not be a git commit. KV is eventually consistent across Cloudflare
// locations; for one friend group in one country that is fine.
// ═══════════════════════════════════════════════════════════════════════════
import { S, HttpError, readLeague, writeLeague, publicData, playerIndex } from './store.js';
import { notify } from './push.js';

const CHAT_MAX = 300;
const ADMIN_ID = 'admin';
const chatGet = async env => (await env.LEAGUE.get('chat', 'json')) || [];

export async function chatState(env, me) {
  return { messages: await chatGet(env), muted: me ? !!(await env.LEAGUE.get(`chatmute:${me}`)) : false };
}
export async function chatLast(env) {
  const list = await chatGet(env);
  const m = list[list.length - 1];
  return m ? { id: m.id, at: m.at, m: m.m } : null;
}

// `me` is a manager id, or ADMIN_ID for the admin
export async function chatPost(env, me, text) {
  text = String(text || '').replace(/\r/g, '').trim().slice(0, 500);
  if (!text) throw new HttpError(400, 'Leere Nachricht');
  const { data: league } = await readLeague(env);
  const author = me === ADMIN_ID ? { id: ADMIN_ID, name: 'Admin' } : (league.managers || []).find(m => m.id === me);
  if (!author) throw new HttpError(401, 'Dein Zugang existiert nicht mehr.');
  const list = await chatGet(env);
  const mine = list.filter(m => m.m === me);
  if (mine.length && Date.now() - Date.parse(mine[mine.length - 1].at) < 2000) throw new HttpError(429, 'Nicht so schnell 🙂');
  const msg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), m: me, t: text, at: new Date().toISOString() };
  list.push(msg);
  await env.LEAGUE.put('chat', JSON.stringify(list.slice(-CHAT_MAX)));
  // push to everyone else who has not muted the chat (one collapsing notification)
  const to = [];
  for (const m of league.managers || []) if (m.id !== me && !(await env.LEAGUE.get(`chatmute:${m.id}`))) to.push(m.id);
  await notify(env, to, { title: `💬 ${author.name}`, body: text.slice(0, 140), url: './#/chat', tag: 'chat' }).catch(() => {});
  return { message: msg };
}

// members delete their own lines, the admin any line
export async function chatDelete(env, me, id) {
  const list = await chatGet(env);
  const i = list.findIndex(m => m.id === id);
  if (i < 0) throw new HttpError(404, 'Nachricht nicht gefunden');
  if (me !== ADMIN_ID && list[i].m !== me) throw new HttpError(403, 'Nur eigene Nachrichten löschen');
  list.splice(i, 1);
  await env.LEAGUE.put('chat', JSON.stringify(list));
  return { ok: true };
}
export async function chatMute(env, me, mute) {
  if (mute) await env.LEAGUE.put(`chatmute:${me}`, '1'); else await env.LEAGUE.delete(`chatmute:${me}`);
  return { muted: !!mute };
}

// ── lineup reminder ────────────────────────────────────────────────────────
// 3 h before a week locks: tell each manager which starters probably will not
// score - their team has no match that week, or they sat out their team's
// last series (benched IRL). One message per week (KV flag).
export async function lineupReminders(env, data, at) {
  if (S.draftStatus(data) !== 'done' || !S.lineupConfig(data).enabled) return null;
  const schedule = await publicData(env, 'schedule.json', 60);
  if (!schedule) return null;
  const cal = S.calendar(schedule), now = at || Date.now();
  const key = cal.keys.find(k => cal.start.get(k) > now);
  if (!key || cal.start.get(key) - now > 3 * 3600e3) return null;
  if (await env.LEAGUE.get(`lrem:${key}`)) return null;
  await env.LEAGUE.put(`lrem:${key}`, '1', { expirationTtl: 30 * 86400 });
  const [stats, idx] = await Promise.all([publicData(env, 'stats.json', 300), playerIndex(env)]);
  if (!stats) return null;
  const evs = (schedule.events || []);
  const playing = new Set(evs.filter(e => cal.blockOf.get(e.match) === key).flatMap(e => e.teams.map(t => t.code)));
  const seen = new Set(stats.games.map(g => g.match + '|' + g.player)), recorded = new Set(stats.games.map(g => g.match));
  const lastSeries = code => evs.filter(e => e.state === 'completed' && e.teams.some(t => t.code === code) && Date.parse(e.start) < now)
    .sort((a, b) => b.start.localeCompare(a.start))[0];
  const lock = new Date(cal.start.get(key)).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  const sent = [];
  for (const m of data.managers || []) {
    const lu = S.lineupPreview(data, stats, idx, schedule, m.id, key);
    if (!lu) continue;
    const issues = [];
    for (const id of lu.starters) {
      const p = idx.get(id) || {};
      if (!playing.has(p.team)) { issues.push(`${p.name || id} (Team spielt nicht)`); continue; }
      const last = lastSeries(p.team);
      if (last && recorded.has(last.match) && !seen.has(last.match + '|' + id)) issues.push(`${p.name || id} (zuletzt nicht gespielt)`);
    }
    if (!issues.length) continue;
    await notify(env, [m.id], { title: `Aufstellung sperrt um ${lock} Uhr`, body: `Achtung: ${issues.join(', ')}.`, url: './#/mein-team', tag: 'lineup' }).catch(() => {});
    sent.push(m.id);
  }
  return { key, sent };
}

// ── weekly recap push ──────────────────────────────────────────────────────
// Once a week is over (>= 10 h after its last match, so the stats job ran)
// and only at a civil hour in Germany. Weeks older than 3 days are never
// announced (no flood after a deploy or a new season).
export async function recapPush(env, data, at) {
  if (S.draftStatus(data) !== 'done') return null;
  const now = at || Date.now();
  const hour = S.berlinParts(now).h;
  if (hour < 9 || hour >= 22) return null;
  const schedule = await publicData(env, 'schedule.json', 60);
  if (!schedule) return null;
  const cal = S.calendar(schedule);
  const done = cal.keys.filter(k => {
    const last = cal.end.get(k);
    const evs = (schedule.events || []).filter(e => cal.blockOf.get(e.match) === k);
    return evs.length && evs.every(e => e.state === 'completed') && now - last >= 10 * 3600e3 && now - last < 3 * 86400e3;
  });
  const key = done[done.length - 1];
  if (!key || await env.LEAGUE.get(`recap:${key}`)) return null;
  await env.LEAGUE.put(`recap:${key}`, '1', { expirationTtl: 60 * 86400 });
  await notify(env, (data.managers || []).map(m => m.id), { title: `Rückblick: ${cal.name(key)}`,
    body: 'Wer hat die Woche gewonnen, Spieler und Flop der Woche — jetzt im Rückblick.', url: './#/rueckblick', tag: 'recap' }).catch(() => {});
  return key;
}

// ── hall of fame ───────────────────────────────────────────────────────────
async function hallInputs(env) {
  const [stats, schedule, season, official, idx] = await Promise.all([publicData(env, 'stats.json', 300), publicData(env, 'schedule.json', 300),
    publicData(env, 'season.json', 300), publicData(env, 'standings.json', 300), playerIndex(env)]);
  if (!stats || !schedule) throw new HttpError(503, 'Stats gerade nicht erreichbar');
  return { stats, schedule, season, official, idx };
}
// cron: freeze every split that is due, plus the season once all its splits are in
export async function hallCron(env, data) {
  const season0 = await publicData(env, 'season.json', 300);
  if (!S.hallDue(data, season0).length) return null;
  const { stats, schedule, season, official, idx } = await hallInputs(env);
  const due = S.hallDue(data, season);
  if (!due.length) return null;
  const entries = {};
  for (const split of due) entries[split] = S.hallEntry(data, stats, idx, schedule, split, official);
  const res = await writeLeague(env, l => {
    l.hall = l.hall || {};
    for (const split of due) if (!l.hall[split]) l.hall[split] = entries[split];
    const all = (season.tournaments || []).map(t => t.slug);
    const sk = 'season_' + season.season;
    if (all.length && all.every(x => l.hall[x]) && !l.hall[sk]) {
      const rows = S.standings(l, stats, idx, schedule, season, official);
      l.hall[sk] = { season: season.season, at: new Date().toISOString(),
        table: rows.map(r => ({ manager: r.manager, name: r.name, pts: r.total, pickem: r.pickem })) };
    }
    return l;
  }, `Ruhmeshalle: ${due.join(', ')}`);
  return { due, changed: res.changed };
}
// admin: (re)build one split now, even for history, or remove an entry
export async function hallAdmin(env, body) {
  const split = String(body.split || '');
  if (!/^[a-z0-9_]+$/.test(split)) throw new HttpError(400, 'Split fehlt');
  if (body.action === 'delete') {
    await writeLeague(env, l => { if (l.hall) delete l.hall[split]; return l; }, `Ruhmeshalle: ${split} entfernt`);
    return { message: `Ruhmeshalle: ${split} entfernt` };
  }
  const { stats, schedule, official, idx } = await hallInputs(env);
  const { data } = await readLeague(env);
  const entry = S.hallEntry(data, stats, idx, schedule, split, official);
  await writeLeague(env, l => { l.hall = l.hall || {}; l.hall[split] = entry; return l; }, `Ruhmeshalle: ${split} neu berechnet`);
  return { message: `Ruhmeshalle: ${split} eingetragen (Sieger ${entry.table[0] ? entry.table[0].name : '—'})` };
}
