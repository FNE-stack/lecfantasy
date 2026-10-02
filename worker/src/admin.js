// ═══════════════════════════════════════════════════════════════════════════
// admin.js — the admin backbone: intervene anywhere, undo anything.
//
// Every operation is named, validated and committed through writeLeague, so
// each one is a commit in the league history and can be rolled back with
// "restore". Ops that touch KV (passwords, sessions) never write the league.
// If an op would break league.json, writeLeague refuses it; the raw editor
// can override that deliberately (allowInvalid) as the very last resort.
// ═══════════════════════════════════════════════════════════════════════════
import { S, HttpError, cfg, writeLeague, readLeagueFresh, leagueHistory, leagueAt, playerIndex,
         pagesMeta, writeSiteFile, githubRaw } from './store.js';
import { setMemberPassword, deleteMember, revokeSessions, sessionCounts, hasPassword, randomHex } from './auth.js';
import { addMember, makePick, cleanName, nameKey, mgrName } from './draft.js';
import { notify, subscriberCounts, pushEnabled } from './push.js';

const now = () => new Date().toISOString();
const need = (cond, msg) => { if (!cond) throw new HttpError(400, msg); };
const findMgr = (league, id) => { const m = (league.managers || []).find(x => x.id === id); need(m, 'Unbekannter Manager: ' + id); return m; };

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── league mutations: (league, op) -> league, plus a commit message ───────
const LEAGUE_OPS = {
  undoPick(l) {
    need(l.draft.picks.length, 'Es gibt keinen Pick zum Rückgängigmachen');
    const p = l.draft.picks.pop();
    if (S.draftStatus(l) === 'done') { l.draft.status = 'live'; l.draft.completed = false; }
    return `Pick #${l.draft.picks.length + 1} rückgängig (${mgrName(l, p.manager)})`;
  },
  removePick(l, op) {
    const i = Number(op.index);
    need(Number.isInteger(i) && i >= 0 && i < l.draft.picks.length, 'Ungültiger Pick-Index');
    const p = l.draft.picks.splice(i, 1)[0];
    if (S.draftStatus(l) === 'done') { l.draft.status = 'live'; l.draft.completed = false; }
    return `Pick #${i + 1} entfernt (${mgrName(l, p.manager)})`;
  },
  replacePick(l, op, ctx) {
    const i = Number(op.index);
    need(Number.isInteger(i) && i >= 0 && i < l.draft.picks.length, 'Ungültiger Pick-Index');
    need(ctx.players.has(op.player) || op.force, 'Spieler nicht im Pool');
    const owner = S.ownership(l).get(op.player);
    need(!owner, `Spieler gehört schon ${mgrName(l, owner)}`);
    const old = l.draft.picks[i].player;
    l.draft.picks[i] = Object.assign({}, l.draft.picks[i], { player: op.player, by: 'admin', at: l.draft.picks[i].at || now() });
    return `Pick #${i + 1} geändert: ${(ctx.players.get(old) || {}).name || old} → ${(ctx.players.get(op.player) || {}).name || op.player}`;
  },
  setPickManager(l, op) {
    const i = Number(op.index);
    need(Number.isInteger(i) && i >= 0 && i < l.draft.picks.length, 'Ungültiger Pick-Index');
    findMgr(l, op.manager);
    l.draft.picks[i].manager = op.manager;
    return `Pick #${i + 1} gehört jetzt ${mgrName(l, op.manager)}`;
  },
  setStatus(l, op) {
    need(['lobby', 'live', 'done'].includes(op.status), 'Status: lobby, live oder done');
    if (op.status === 'live') need(l.draft.order.length >= 1, 'Mindestens ein Manager nötig');
    l.draft.status = op.status;
    l.draft.completed = op.status === 'done';
    if (op.status === 'live' && !l.draft.startedAt) l.draft.startedAt = now();
    if (op.status === 'live' && !(l.draft.picks || []).length) l.draft.startedAt = now();
    return { lobby: 'Anmeldung geöffnet', live: 'Draft gestartet', done: 'Draft gesperrt' }[op.status];
  },
  resetDraft(l) {
    // swaps, trades and point corrections refer to the old rosters - a fresh
    // draft without them is the only consistent state
    l.draft.picks = []; l.draft.status = 'lobby'; l.draft.completed = false; delete l.draft.startedAt;
    l.swaps = []; l.trades = []; l.adjustments = [];
    return 'Draft zurückgesetzt (Picks, Wechsel, Trades und Punktekorrekturen gelöscht; Mitglieder und Einstellungen bleiben)';
  },
  setOrder(l, op) {
    const ids = (l.managers || []).map(m => m.id);
    need(Array.isArray(op.order), 'order muss eine Liste sein');
    need(op.order.every(id => ids.includes(id)) && new Set(op.order).size === op.order.length, 'Reihenfolge enthält unbekannte oder doppelte Manager');
    need(!l.draft.picks.length || op.force, 'Reihenfolge nach dem ersten Pick ändern verschiebt alle Züge — mit force bestätigen');
    l.draft.order = op.order.slice();
    return 'Draft-Reihenfolge: ' + op.order.map(id => mgrName(l, id)).join(', ');
  },
  shuffleOrder(l, op) {
    need(!l.draft.picks.length || op.force, 'Erst nach Reset auslosen — es gibt schon Picks');
    l.draft.order = shuffle(l.draft.order.length ? l.draft.order : l.managers.map(m => m.id));
    return 'Draft-Reihenfolge ausgelost: ' + l.draft.order.map(id => mgrName(l, id)).join(', ');
  },
  setSnake(l, op) { l.draft.snake = !!op.snake; return 'Snake ' + (op.snake ? 'an' : 'aus'); },
  renameManager(l, op) {
    const m = findMgr(l, op.manager), name = cleanName(op.name);
    need(!(l.managers || []).some(x => x.id !== m.id && nameKey(x.name) === nameKey(name)), 'Den Namen gibt es schon');
    const old = m.name; m.name = name;
    return `Umbenannt: ${old} → ${name}`;
  },
  removeManager(l, op, ctx) {
    const m = findMgr(l, op.manager);
    const picks = l.draft.picks.filter(p => p.manager === m.id).length;
    need(!picks || op.force, `${m.name} hat ${picks} Picks — erst Draft zurücksetzen oder mit force (Picks werden gelöscht)`);
    l.draft.picks = l.draft.picks.filter(p => p.manager !== m.id);
    l.managers = l.managers.filter(x => x.id !== m.id);
    l.draft.order = l.draft.order.filter(x => x !== m.id);
    ctx.after.push(env => deleteMember(env, m.id));
    return `${m.name} entfernt`;
  },
  adjust(l, op) {
    const m = findMgr(l, op.manager), pts = Number(op.pts);
    need(isFinite(pts) && pts !== 0, 'Punkte müssen eine Zahl ≠ 0 sein');
    (l.adjustments = l.adjustments || []).push({ manager: m.id, pts, reason: String(op.reason || '').slice(0, 120), at: now() });
    return `${pts > 0 ? '+' : ''}${pts} Punkte für ${m.name}${op.reason ? ' (' + op.reason + ')' : ''}`;
  },
  removeAdjust(l, op) {
    const i = Number(op.index);
    need((l.adjustments || [])[i], 'Ungültiger Index');
    const a = l.adjustments.splice(i, 1)[0];
    return `Punktekorrektur entfernt (${mgrName(l, a.manager)} ${a.pts})`;
  },
  addSwap(l, op, ctx) {
    const m = findMgr(l, op.manager);
    const own = S.ownership(l);
    need(own.get(op.out) === m.id, 'Der abgegebene Spieler gehört nicht diesem Manager');
    need(!own.has(op.in), 'Der neue Spieler ist nicht frei');
    need(ctx.players.has(op.in), 'Neuer Spieler nicht im Pool');
    (l.swaps = l.swaps || []).push({ manager: m.id, out: op.out, in: op.in, at: op.retro ? '' : now() });
    return `Wechsel ${m.name}: ${(ctx.players.get(op.out) || {}).name || op.out} → ${(ctx.players.get(op.in) || {}).name || op.in}`;
  },
  removeSwap(l, op) {
    const i = Number(op.index);
    need((l.swaps || [])[i], 'Ungültiger Index');
    l.swaps.splice(i, 1);
    return 'Wechsel entfernt';
  },
  setScoring(l, op) {
    const s = op.scoring || {};
    for (const k of ['kill', 'death', 'assist', 'cs10', 'win']) need(typeof s[k] === 'number' && isFinite(s[k]), 'scoring.' + k + ' muss eine Zahl sein');
    l.scoring = { kill: s.kill, death: s.death, assist: s.assist, cs10: s.cs10, win: s.win };
    return 'Punkteregeln geändert';
  },
  setRoster(l, op) {
    const r = op.roster || {};
    need(Array.isArray(r.slots) && r.slots.length, 'slots fehlen');
    need(!l.draft.picks.length || op.force, 'Kaderregeln nach Draftbeginn ändern — mit force bestätigen');
    l.roster = { slots: r.slots, bench: Math.max(0, r.bench | 0), maxPerTeam: Math.max(1, r.maxPerTeam | 0) };
    return 'Kaderregeln geändert';
  },
  setTimer(l, op) {
    need(['off', 'soft', 'auto'].includes(op.mode), 'Timer: off, soft oder auto');
    const sec = Number(op.seconds) || 90;
    need(sec >= 15 && sec <= 3600, 'Timer: 15–3600 Sekunden');
    l.draft.timer = { mode: op.mode, seconds: sec };
    return `Pick-Timer: ${op.mode}${op.mode !== 'off' ? ' ' + sec + ' s' : ''}`;
  },
  setTradeRules(l, op) {
    const r = op.rules || {};
    need(['windows', 'always'].includes(r.mode || 'windows'), 'Modus: windows oder always');
    const windows = (r.windows || []).map(w => ({ from: w.from, to: w.to, label: String(w.label || '').slice(0, 40) }));
    for (const w of windows) {
      need(!isNaN(Date.parse(w.from)) && !isNaN(Date.parse(w.to)), 'Fenster braucht gültiges Von und Bis');
      need(w.from < w.to, `Fenster „${w.label || w.from.slice(0, 10)}": Von muss vor Bis liegen`);
    }
    const per = Number(r.perWeek ?? 1);
    need(Number.isInteger(per) && per >= 0 && per <= 20, 'Free Agents pro Woche: 0–20 (0 = unbegrenzt)');
    l.tradeRules = { enabled: !!r.enabled, freeAgents: !!r.freeAgents, perWeek: per, adminApproval: !!r.adminApproval,
      equalCount: r.equalCount !== false, rosterRules: r.rosterRules !== false, mode: r.mode || 'windows',
      windows: windows.sort((a, b) => a.from.localeCompare(b.from)) };
    return `Transfers: Trades ${r.enabled ? 'an' : 'aus'}, Free Agents ${r.freeAgents ? 'an' : 'aus'}, `
      + (l.tradeRules.mode === 'always' ? 'immer offen' : `${windows.length} Fenster`);
  },
  decideTrade(l, op) {
    const t = (l.trades || []).find(x => x.id === op.id);
    need(t, 'Trade nicht gefunden');
    need(['accepted', 'vetoed', 'rejected', 'cancelled'].includes(op.status), 'Status ungültig');
    t.status = op.status; t.decidedAt = now(); t.by = 'admin';
    return `Trade ${t.id}: ${op.status} (Admin)`;
  },
  announce(l, op) {
    const text = String(op.text || '').trim().slice(0, 280);
    l.announcement = text ? { text, at: now() } : null;
    return text ? 'Ankündigung gesetzt' : 'Ankündigung entfernt';
  },
  setStandingsMode(l, op) {
    need(['points', 'h2h'].includes(op.mode), 'Modus: points oder h2h');
    l.standingsMode = op.mode;
    return 'Haupttabelle: ' + (op.mode === 'h2h' ? 'Head-to-Head' : 'Gesamtpunkte');
  },
  setName(l, op) { l.name = String(op.name || '').trim().slice(0, 40) || 'LEC Fantasy'; return 'Liganame: ' + l.name; },
  setJoin(l, op) { l.joinOpen = !!op.open; return 'Anmeldung ' + (op.open ? 'offen' : 'geschlossen'); },
};

export async function runOp(env, op) {
  need(op && typeof op.op === 'string', 'op fehlt');
  const players = await playerIndex(env).catch(() => new Map());
  const ctx = { players, after: [] };

  // ops that are not plain league edits
  switch (op.op) {
    case 'pickFor': {
      need(op.player, 'Spieler fehlt');
      const r = await makePick(env, op.manager || null, op.player, { by: 'admin', force: !!op.force });
      return { message: 'Pick gesetzt', league: r.league };
    }
    case 'addManager': {
      const m = await addMember(env, op.name, { admin: true, force: !!op.force });
      if (op.password) await setMemberPassword(env, m.id, op.password);
      return { message: `${m.name} hinzugefügt${op.password ? '' : ' (ohne Passwort — setz eins)'}`, manager: m };
    }
    case 'setPassword': {
      const { data } = await readLeagueFresh(env);
      const m = findMgr(data, op.manager);
      await setMemberPassword(env, m.id, op.password);
      const n = await revokeSessions(env, m.id);
      return { message: `Neues Passwort für ${m.name} gesetzt, ${n} Sitzung(en) abgemeldet` };
    }
    case 'kick': {
      const n = await revokeSessions(env, op.manager || null);
      return { message: `${n} Sitzung(en) abgemeldet` };
    }
    case 'setRaw': {
      need(op.league && typeof op.league === 'object', 'league fehlt');
      const v = S.validateLeague(op.league, players);
      need(!v.errors.length || op.force, 'Ungültig: ' + v.errors.map(e => e.msg).join('; '));
      const r = await writeLeague(env, () => op.league, 'admin: league.json manuell bearbeitet', { allowInvalid: !!op.force });
      return { message: 'league.json gespeichert', league: r.league };
    }
    case 'restore': {
      need(op.sha, 'sha fehlt');
      const old = await leagueAt(env, op.sha);
      const r = await writeLeague(env, () => old, `admin: zurückgesetzt auf ${op.sha.slice(0, 7)}`, { allowInvalid: !!op.force });
      return { message: `Stand ${op.sha.slice(0, 7)} wiederhergestellt`, league: r.league };
    }
    case 'override': case 'removeOverride': {
      const msg = op.op === 'override' ? 'stats: Korrektur durch Admin' : 'stats: Korrektur entfernt';
      const file = await writeSiteFile(env, 'data/overrides.json', cur => {
        const o = cur || { rows: [] };
        if (op.op === 'override') {
          need(['set', 'exclude', 'add'].includes(op.entry && op.entry.op), 'entry.op: set, exclude oder add');
          o.rows.push(Object.assign({}, op.entry, { at: now() }));
        } else {
          need(o.rows[op.index], 'Ungültiger Index');
          o.rows.splice(op.index, 1);
        }
        return o;
      }, msg);
      return { message: msg.replace('stats: ', ''), overrides: file };
    }
    case 'setTournament': {
      const t = String(op.tournament || 'auto').trim();
      await writeSiteFile(env, 'data/config.json', cur => Object.assign({}, cur || {}, { tournament: t }), `config: Turnier ${t}`);
      const r = await writeLeague(env, l => { l.tournament = t; return l; }, `admin: Turnier ${t}`);
      return { message: `Turnier: ${t} (gilt ab dem nächsten Stats-Update)`, league: r.league };
    }
    case 'fix':
      need(op.fix && op.fix.op, 'fix fehlt');
      return runOp(env, op.fix);
  }

  const fn = LEAGUE_OPS[op.op];
  need(fn, 'Unbekannte Aktion: ' + op.op);
  let msg = '';
  const r = await writeLeague(env, l => { msg = fn(l, op, ctx); return l; }, () => 'admin: ' + msg);
  for (const job of ctx.after) await job(env);
  return { message: msg, league: r.league, changed: r.changed };
}

// ── everything the admin page shows ───────────────────────────────────────
export async function adminState(env) {
  const { data: league, sha } = await readLeagueFresh(env);
  const players = await playerIndex(env).catch(() => null);
  const ids = (league.managers || []).map(m => m.id);
  const [sessions, pushSubs] = await Promise.all([
    sessionCounts(env).catch(() => ({})),
    subscriberCounts(env, ids).catch(() => ({})),
  ]);
  const members = [];
  for (const m of league.managers || []) {
    members.push({ id: m.id, name: m.name, joined: m.joined || null,
      hasPassword: await hasPassword(env, m.id), sessions: sessions[m.id] || 0, push: pushSubs[m.id] || 0 });
  }
  const invite = await env.LEAGUE.get('invite', 'json');
  return {
    league, sha, members, invite,
    validation: S.validateLeague(league, players),
    capacity: players ? S.capacity(league, players) : null,
    onTheClock: S.currentPicker(league), progress: S.draftProgress(league),
    pushEnabled: pushEnabled(env), dataRepo: cfg(env).data, privateData: cfg(env).data !== cfg(env).site,
  };
}

export async function rotateInvite(env) {
  const invite = { code: randomHex(9), created: now() };
  await env.LEAGUE.put('invite', JSON.stringify(invite));
  return invite;
}

export async function health(env) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const c = cfg(env);
  // GitHub token + repo write access
  try {
    const rl = await (await githubRaw(env, '/rate_limit')).json();
    const core = rl.resources && rl.resources.core;
    add('GitHub-API', !!core && core.remaining > 200, core ? `${core.remaining}/${core.limit} Anfragen übrig, Reset ${new Date(core.reset * 1000).toLocaleTimeString('de-DE')}` : 'keine Antwort');
  } catch (e) { add('GitHub-API', false, e.message); }
  for (const [label, repo] of [['Daten-Repo', c.data], ['Seiten-Repo', c.site]]) {
    if (label === 'Seiten-Repo' && repo === c.data) continue;
    try {
      const r = await githubRaw(env, `/repos/${repo}`);
      const j = await r.json();
      add(`${label} ${repo}`, r.ok && j.permissions && j.permissions.push, r.ok ? `Schreibrecht: ${j.permissions && j.permissions.push ? 'ja' : 'NEIN'} · ${j.private ? 'privat' : 'öffentlich'}` : `HTTP ${r.status}`);
    } catch (e) { add(label, false, e.message); }
  }
  // KV round trip
  try {
    const v = randomHex(4);
    await env.LEAGUE.put('health', v, { expirationTtl: 120 });
    add('KV-Speicher', (await env.LEAGUE.get('health')) === v, 'Schreiben + Lesen');
  } catch (e) { add('KV-Speicher', false, e.message); }
  // data freshness
  const meta = await pagesMeta(env);
  const st = meta['stats.json'] || {};
  const age = st.updated ? (Date.now() / 1000 - st.updated) / 3600 : null;
  add('Stats-Daten', !!st.updated && age < 30, st.updated ? `Stand vor ${age.toFixed(1)} h · ${st.tournament}` : (st.error || 'unbekannt'));
  // last workflow run
  try {
    const r = await githubRaw(env, `/repos/${c.site}/actions/workflows/update-stats.yml/runs?per_page=1`);
    if (r.status === 403) add('Stats-Job', null, 'Token hat kein Actions-Recht — Status unbekannt');
    else {
      const run = ((await r.json()).workflow_runs || [])[0];
      add('Stats-Job', !!run && run.conclusion === 'success', run ? `${run.status}/${run.conclusion || '—'} · ${new Date(run.created_at).toLocaleString('de-DE')}` : 'noch nie gelaufen');
    }
  } catch (e) { add('Stats-Job', null, e.message); }
  add('Push', pushEnabled(env), pushEnabled(env) ? 'VAPID-Schlüssel gesetzt' : 'nicht eingerichtet');
  add('Admin-Passwort', !!env.ADMIN_PASSWORD, 'gesetzt');
  return checks;
}

export async function runStats(env, tournament) {
  const c = cfg(env);
  const r = await githubRaw(env, `/repos/${c.site}/actions/workflows/update-stats.yml/dispatches`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: c.branch, inputs: tournament ? { tournament } : {} }),
  });
  if (r.status === 403) throw new HttpError(403, 'Der GitHub-Token hat kein Recht „Actions: Read and write" — im Token ergänzen.');
  if (!r.ok) throw new HttpError(502, `Start fehlgeschlagen (${r.status})`);
  return { message: 'Stats-Update gestartet — dauert ca. 1–3 Minuten.' };
}

export async function broadcast(env, text) {
  const { data } = await readLeagueFresh(env);
  return notify(env, (data.managers || []).map(m => m.id), { title: data.name || 'LEC Fantasy', body: String(text).slice(0, 200), url: './#/', tag: 'announce' });
}

export { leagueHistory };
