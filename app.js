// ═══════════════════════════════════════════════════════════════════════════
// app.js — the whole site as one app with real URLs (#/spieler/<id> etc.).
//
// Logged out: only public LEC data (results, schedule, pro players) + login.
// Logged in:  the league, which comes ONLY from the Worker after login — it is
//             private, there is no public file with members or picks.
// Rules from scoring.js, data + display bits from common.js, admin in
// admin-ui.js. Nothing in here can write anything without the Worker.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
'use strict';

const WORKER = 'https://lecfantasy-draft.fabian-neidl.workers.dev';
const GW = 'https://esports-api.lolesports.com/persisted/gw/';
const GW_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';   // public key of lolesports.com
const FEED = 'https://feed.lolesports.com/livestats/v1/';
const U = window.LECUI, S = window.LECScoring, esc = U.esc, fmt = U.fmt;
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

let D = null;                     // public data; D.league set from the Worker
let LIVE = null;                  // last /api/state
let session = store.get('lf.session', '');
let SEASON = new Map(), WEEK_OF = new Map(), BLOCKS = [];
const ui = { role: '', team: '', q: '', avail: true, watch: false, sort: 'pts', psort: 'pts', prole: '', busy: false, table: null };
let watch = store.get('lf.watch', []);           // ordered: also the auto-pick queue
let lastPickCount = null, wasMyTurn = false, routeKey = '', liveNow = [];

// ── helpers ───────────────────────────────────────────────────────────────
const L = () => D && D.league;
const loggedIn = () => !!(session && LIVE && D.league);
const me = () => (LIVE && LIVE.me ? LIVE.me.id : '');
const status = () => (L() ? S.draftStatus(L()) : 'lobby');
const mgr = id => ((L() && L().managers) || []).find(m => m.id === id);
const mgrName = id => { const m = mgr(id); return m ? m.name : id; };
const initials = n => String(n || '?').trim().slice(0, 1).toUpperCase();
const blockLabel = b => (b || '').replace(/^Week (\d+)$/, 'Woche $1').replace('Finals', 'Finale');
const scoring = () => (L() && L().scoring) || U.DEFAULT_SCORING;
const season = id => { if (!SEASON.has(id)) SEASON.set(id, U.playerSeason(D, id)); return SEASON.get(id); };
const owner = id => (L() ? S.ownership(L()).get(id) || null : null);
const f1 = n => (Number(n) || 0).toFixed(1).replace('.', ',');
const dt = iso => new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const day = iso => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
const tourLabel = () => (D.stats.tournament || '').replace(/^lec_/, '').replace(/_/g, ' ').toUpperCase();
const logo = (code, size) => U.teamLogo(D, code, size || 20);
const pcell = (id, opts) => U.playerCell(D, id, Object.assign({ link: true }, opts || {}));
const card = (title, body, right) => `<section class="card"><div class="card-h"><h2>${title}</h2>${right ? `<span class="r">${right}</span>` : ''}</div>${body}</section>`;
const pageHead = (eyebrow, title, right) => `<div class="row" style="justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px"><div><div class="eyebrow">${eyebrow}</div><h1 style="font-size:40px">${title}</h1></div>${right || ''}</div>`;

function rebuild() {
  SEASON = new Map(); WEEK_OF = new Map();
  const seen = [];
  for (const e of D.schedule.events || []) {
    WEEK_OF.set(e.match, e.block);
    if (e.block && !seen.includes(e.block)) seen.push(e.block);
  }
  BLOCKS = seen;
}

function teamRecord(code) {
  let w = 0, l = 0;
  for (const e of D.schedule.events || []) {
    if (e.state !== 'completed') continue;
    const t = e.teams.find(x => x.code === code);
    if (!t) continue;
    if (t.outcome === 'win') w++; else if (t.outcome === 'loss') l++;
  }
  return { w, l };
}
const upcomingEvents = () => (D.schedule.events || []).filter(e => e.state !== 'completed' && new Date(e.start).getTime() > Date.now() - 4 * 3600e3);
const nextMatch = code => upcomingEvents().find(e => e.teams.some(t => t.code === code)) || null;
const opp = (e, code) => { const o = e.teams.find(t => t.code !== code); return o ? o.code : '?'; };
// the block being played now/next; else the last one that was played
function currentBlock() {
  const up = upcomingEvents()[0];
  if (up && up.block) return up.block;
  const played = BLOCKS.filter(b => D.stats.games.some(g => WEEK_OF.get(g.match) === b));
  return played[played.length - 1] || BLOCKS[0] || null;
}

function standings() {
  const rows = S.standings(L(), D.stats, D.P);
  const wk = S.weeklyPoints(L(), D.stats, WEEK_OF);
  const lastBlock = [...BLOCKS].reverse().find(b => D.stats.games.some(g => WEEK_OF.get(g.match) === b));
  const lead = rows.length ? rows[0].total : 0;
  return rows.map((r, i) => Object.assign(r, {
    rank: i + 1, gap: lead - r.total, week: lastBlock ? (wk[r.manager] || {})[lastBlock] || 0 : 0,
    ids: r.perPlayer.filter(p => p.current).map(p => p.player),
  }));
}
const h2h = () => S.h2h(L(), D.stats, WEEK_OF, BLOCKS);

// ── small renderers ───────────────────────────────────────────────────────
function avatars(ids, n) {
  return '<span class="avatars">' + ids.slice(0, n || 6).map(id => {
    const p = D.P.get(id);
    return p && p.photo ? `<img src="${esc(p.photo)}" alt="" title="${esc(p.name)}" loading="lazy">` : '';
  }).join('') + '</span>';
}
function spark(id, n) {
  const rows = season(id).rows.slice(-(n || 8));
  if (!rows.length) return '<span class="dim">—</span>';
  return '<span class="spark" title="letzte Spiele">' + rows.map(r => {
    const p = Math.max(0, S.gamePoints(r, scoring()));
    return `<i class="${r.win ? '' : 'l'}" style="height:${Math.max(3, Math.min(22, p / 2.6))}px"></i>`;
  }).join('') + '</span>';
}
function matchLine(e, code) {
  const [a, b] = e.teams;
  const done = e.state === 'completed';
  const score = done ? `<b class="num">${a.wins ?? 0}–${b.wins ?? 0}</b>` : `<span class="dim">Bo${e.bestOf}</span>`;
  const mark = code && done ? ((e.teams.find(t => t.code === code) || {}).outcome === 'win' ? ' <span class="wl w">W</span>' : ' <span class="wl l">L</span>') : '';
  return `<span class="row" style="gap:8px">${logo(a.code, 22)}<b>${esc(a.code)}</b>${score}<b>${esc(b.code)}</b>${logo(b.code, 22)}${mark}</span>`;
}
function eventRows(list, withDate) {
  return list.length ? list.map(e => `<div class="row" style="padding:11px 16px;border-bottom:1px solid var(--line);justify-content:space-between;gap:8px">
    ${matchLine(e)}<span class="dim" style="font-size:12px;white-space:nowrap">${withDate ? esc(dt(e.start)) : esc(blockLabel(e.block))}</span></div>`).join('')
    : '<div class="empty">—</div>';
}
function topProsCard(n, withOwner) {
  const top = D.players.players.map(p => ({ p, s: season(p.id) })).sort((a, b) => b.s.pts - a.s.pts).slice(0, n);
  return card('Top Spieler', '<table><tbody>' + top.map((x, i) => {
    const o = withOwner && owner(x.p.id);
    return `<tr class="click" data-href="#/spieler/${esc(x.p.id)}"><td class="rank r${i + 1}" style="width:30px;font-size:16px">${i + 1}</td>
      <td class="fill">${pcell(x.p.id, { photo: true })}</td>${o ? `<td class="hide-s"><span class="pill gold">${esc(mgrName(o))}</span></td>` : withOwner ? '<td class="hide-s"></td>' : ''}
      <td class="num pts">${fmt(x.s.pts)}</td></tr>`;
  }).join('') + '</tbody></table>', `Fantasy-Punkte · <a href="#/spieler">alle</a>`);
}
function seasonFeed() {
  const results = (D.schedule.events || []).filter(e => e.state === 'completed').slice(-6).reverse();
  const next = upcomingEvents().slice(0, 6);
  return card('Nächste Spiele', next.length ? eventRows(next, true) : '<div class="empty">Noch keine Spiele angesetzt — der Spielplan kommt, sobald Riot ihn veröffentlicht.</div>')
    + card('Letzte Ergebnisse', eventRows(results), '<a href="#/teams">Teams</a>');
}

// ── public views (logged out) ─────────────────────────────────────────────
function loginCard() {
  return card('Einloggen', `<div class="card-b">
    <label>Name</label><input id="lname" autocomplete="username" style="width:100%">
    <label>Passwort</label><input id="lpw" type="password" autocomplete="current-password" style="width:100%">
    <div style="margin-top:14px"><button class="btn gold" id="doLogin">Einloggen</button></div>
    <div id="loginmsg" style="margin-top:12px"></div>
    <p class="muted" style="margin:14px 0 0;font-size:13px">Noch nicht dabei? Du brauchst einen <b style="color:var(--text)">Einladungslink</b> vom Admin.</p>
  </div>`);
}
function viewLanding() {
  return `<section class="hero">
      <div class="eyebrow">${esc(tourLabel())} · LEC</div>
      <h1>LEC Fantasy</h1>
      <div class="sub">Private Liga. Draft dein Team aus echten LEC-Profis und sammle Punkte mit jedem Spiel.</div>
    </section>
    <div class="grid g-main"><div class="stack">${seasonFeed()}</div>
      <div class="stack">${loginCard()}${topProsCard(5, false)}</div></div>`;
}
function bindLogin() {
  const btn = $('doLogin');
  if (!btn) return;
  const go = async () => {
    btn.disabled = true;
    try {
      const r = await api('/api/login', { method: 'POST', body: { name: $('lname').value, password: $('lpw').value } });
      await startSession(r.token);
    } catch (e) { $('loginmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; btn.disabled = false; }
  };
  btn.onclick = go;
  $('lpw').onkeydown = e => { if (e.key === 'Enter') go(); };
}

let joinInfo = null;
function viewJoin(code) {
  if (joinInfo === null) {
    joinInfo = 'loading';
    api('/api/invite', { method: 'POST', body: { code } })
      .then(r => { joinInfo = r; render(true); })
      .catch(e => { joinInfo = { error: e.message }; render(true); });
  }
  if (joinInfo === 'loading') return card('Einladung', '<div class="empty">prüfe Einladung …</div>');
  if (joinInfo.error) return `<div style="max-width:520px;margin:30px auto">${card('Einladung', `<div class="card-b"><div class="msg err">${esc(joinInfo.error)}</div><a href="#/">Zur Startseite</a></div>`)}</div>`;
  const open = joinInfo.status === 'lobby', full = joinInfo.members >= joinInfo.capacity;
  return `<div style="max-width:520px;margin:10px auto">
    <section class="hero"><div class="eyebrow">Einladung</div><h1>${esc(joinInfo.name || 'LEC Fantasy')}</h1>
      <div class="sub">${joinInfo.members} Manager dabei · Platz für ${joinInfo.capacity}</div></section>
    ${!open ? card('Beitreten', '<div class="card-b"><div class="msg err">Die Anmeldung ist geschlossen — der Draft hat schon begonnen. Frag den Admin.</div></div>')
      : full ? card('Beitreten', '<div class="card-b"><div class="msg err">Die Liga ist voll.</div></div>')
      : card('Beitreten', `<div class="card-b">
        <label>Dein Name (sehen alle in der Liga, damit loggst du dich ein)</label><input id="jname" maxlength="24" autocomplete="username" style="width:100%">
        <label>Passwort (min. 6 Zeichen)</label><input id="jpw" type="password" autocomplete="new-password" style="width:100%">
        <label>Passwort wiederholen</label><input id="jpw2" type="password" autocomplete="new-password" style="width:100%">
        <div style="margin-top:14px"><button class="btn gold lg" id="doJoin">Beitreten</button></div>
        <div id="joinmsg" style="margin-top:12px"></div></div>`)}
  </div>`;
}
function bindJoin(code) {
  const btn = $('doJoin');
  if (!btn) return;
  btn.onclick = async () => {
    const msg = t => { $('joinmsg').innerHTML = `<div class="msg err">${esc(t)}</div>`; };
    if ($('jpw').value !== $('jpw2').value) return msg('Die Passwörter sind nicht gleich.');
    btn.disabled = true;
    try {
      const r = await api('/api/join', { method: 'POST', body: { code, name: $('jname').value, password: $('jpw').value } });
      location.hash = '#/';
      await startSession(r.token);
      toast(`Willkommen in der Liga, <b>${esc(r.me.name)}</b>!`);
    } catch (e) { msg(e.message); btn.disabled = false; }
  };
}

// ── league views (logged in) ──────────────────────────────────────────────
function announcement() {
  const a = L().announcement;
  return a && a.text ? `<div class="note" style="display:flex;gap:10px;align-items:flex-start"><span>📣</span><div>${esc(a.text)}</div></div>` : '';
}

function viewHome() {
  const st = status(), prog = S.draftProgress(L()), clock = S.currentPicker(L());
  const members = L().managers || [];
  const mode = ui.table || L().standingsMode || 'points';
  let h = announcement();
  const heroSub = st === 'lobby' ? `Anmeldung läuft — ${members.length} Manager dabei. Der Admin startet den Draft.`
    : st === 'live' ? (clock ? `Draft läuft · Pick ${prog.done + 1}/${prog.total} — <b>${esc(mgrName(clock))}</b> ist am Zug.` : 'Draft läuft.')
    : 'Kader stehen. Punkte kommen automatisch nach jedem LEC-Spieltag.';
  h += `<section class="hero">
    <div class="eyebrow">${st === 'live' ? '<span class="live-dot"></span>&nbsp; Draft live' : st === 'lobby' ? 'Anmeldung' : 'Saison'} · ${esc(tourLabel())}</div>
    <h1>${esc(L().name || 'LEC Fantasy')}</h1><div class="sub">${heroSub}</div>
    <div class="hero-stats">
      <div><div class="big-num">${members.length}</div><div class="k">Manager</div></div>
      <div><div class="big-num">${prog.done}/${prog.total}</div><div class="k">Picks</div></div>
      <div><div class="big-num">${new Set(D.stats.games.map(g => g.game)).size}</div><div class="k">Spiele erfasst</div></div>
    </div>
    <div class="cta">${st !== 'done' ? '<a class="btn gold lg" href="#/draft">Zum Draft</a>' : '<a class="btn gold lg" href="#/mein-team">Mein Team</a>'}</div>
  </section>`;

  const toggle = `<span class="chips"><button class="chip ${mode === 'points' ? 'on' : ''}" data-table="points">Punkte</button><button class="chip ${mode === 'h2h' ? 'on' : ''}" data-table="h2h">Head-to-Head</button></span>`;
  let table;
  if (mode === 'h2h') {
    const hh = h2h();
    table = `<table><thead><tr><th>#</th><th>Manager</th><th class="num">S–N–U</th><th class="num hide-s">Punkte für</th><th class="num hide-s">gegen</th></tr></thead><tbody>` +
      hh.table.map((r, i) => `<tr class="click ${r.manager === me() ? 'me' : ''}" data-href="#/manager/${esc(r.manager)}">
        <td class="rank r${i + 1}">${i + 1}</td><td class="fill"><b>${esc(r.name)}</b>${r.manager === me() ? ' <span class="pill gold">Du</span>' : ''}</td>
        <td class="num pts">${r.w}–${r.l}–${r.t}</td><td class="num hide-s">${fmt(r.pf)}</td><td class="num hide-s dim">${fmt(r.pa)}</td></tr>`).join('') + '</tbody></table>';
  } else {
    table = `<table><thead><tr><th>#</th><th>Manager</th><th class="num hide-s">Letzte Woche</th><th class="num hide-s">Rückstand</th><th class="num">Punkte</th></tr></thead><tbody>` +
      standings().map(r => `<tr class="click ${r.manager === me() ? 'me' : ''}" data-href="#/manager/${esc(r.manager)}">
        <td class="rank r${r.rank}">${r.rank}</td>
        <td class="fill"><div class="row" style="gap:10px;min-width:0"><span class="userchip" style="padding:0;border:0;background:none"><span class="av">${esc(initials(r.name))}</span></span>
          <div style="min-width:0"><b>${esc(r.name)}</b>${r.manager === me() ? ' <span class="pill gold">Du</span>' : ''}${r.adjust ? ` <span class="pill" title="Punktekorrektur">${r.adjust > 0 ? '+' : ''}${fmt(r.adjust)}</span>` : ''}
          <div class="hide-s" style="margin-top:3px">${r.ids.length ? avatars(r.ids, 6) : '<span class="dim" style="font-size:12px">noch kein Kader</span>'}</div></div></div></td>
        <td class="num hide-s">${fmt(r.week)}</td><td class="num hide-s dim">${r.rank === 1 ? '—' : '−' + fmt(r.gap)}</td>
        <td class="num pts" style="font-size:16px">${fmt(r.total)}</td></tr>`).join('') + '</tbody></table>';
  }
  h += `<div class="grid g-main"><div class="stack">${card('Tabelle', table, toggle)}${seasonFeed()}</div><div class="stack">${matchupCard()}${topProsCard(5, true)}</div></div>`;
  return h;
}

function matchupCard(only) {
  const b = currentBlock();
  if (!b || (L().managers || []).length < 2) return '';
  const wk = h2h().weeks.find(w => w.block === b);
  if (!wk) return '';
  const games = wk.games.filter(g => !only || g.a === only || g.b === only);
  const side = (id, pts, right) => id
    ? `<div style="flex:1;min-width:0;text-align:${right ? 'right' : 'left'};${id === me() ? 'color:var(--gold-hi)' : ''}"><b style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(mgrName(id))}</b>${wk.played ? `<span class="pts">${fmt(pts)}</span>` : ''}</div>`
    : `<div style="flex:1;text-align:${right ? 'right' : 'left'}" class="dim">spielfrei</div>`;
  const rows = games.map(g => `<div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line);gap:12px">${side(g.a, g.pa)}<span class="dim" style="font-family:var(--display)">VS</span>${side(g.b, g.pb, true)}</div>`).join('');
  return card(only ? 'Dein Duell' : 'Duelle', rows || '<div class="empty">—</div>', esc(blockLabel(b)) + (wk.played ? '' : ' · kommt'));
}

function viewMine() { return viewManager(me(), true); }

function viewManager(id, isMe) {
  const m = mgr(id);
  if (!m) return card('Manager', '<div class="empty">Manager nicht gefunden.</div>');
  const st = standings(), row = st.find(r => r.manager === id) || { total: 0, rank: '–', gap: 0, perPlayer: [], ids: [], adjust: 0 };
  const ids = row.ids, sc = scoring();
  const wkAll = S.weeklyPoints(L(), D.stats, WEEK_OF)[id] || {};
  const wk = BLOCKS.filter(b => D.stats.games.some(g => WEEK_OF.get(g.match) === b)).map(b => ({ block: b, pts: wkAll[b] || 0 }));
  const max = Math.max(10, ...wk.map(w => w.pts));
  const ahead = st[row.rank - 2];
  const best = row.perPlayer.find(p => p.current) || row.perPlayer[0];

  const teams = new Map();
  for (const pid of ids) { const p = D.P.get(pid); if (p) (teams.get(p.team) || teams.set(p.team, []).get(p.team)).push(pid); }
  const upcoming = upcomingEvents().filter(e => e.teams.some(t => teams.has(t.code))).slice(0, 6);
  const upH = upcoming.length ? upcoming.map(e => `<div class="row" style="padding:11px 16px;border-bottom:1px solid var(--line);justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div><div class="dim" style="font-size:12px">${esc(dt(e.start))} · ${esc(blockLabel(e.block))}</div>${matchLine(e)}</div>${avatars(e.teams.flatMap(t => teams.get(t.code) || []), 5)}</div>`).join('')
    : `<div class="empty">${ids.length ? 'Noch keine Spiele angesetzt — sobald Riot den Spielplan veröffentlicht, stehen hier die nächsten Spiele deiner Spieler.' : 'Erst draften, dann gibt es Spiele.'}</div>`;

  const rosterRows = ids.map(pid => {
    const p = D.P.get(pid) || {}, s = season(pid), nm = nextMatch(p.team), lastG = s.rows[s.rows.length - 1];
    return `<tr class="click" data-href="#/spieler/${esc(pid)}"><td class="fill">${pcell(pid, { photo: true })}</td>
      <td class="hide-s dim" style="white-space:nowrap;font-size:12px">${nm ? esc(dt(nm.start)) + ' vs ' + esc(opp(nm, p.team)) : '—'}</td>
      <td class="hide-s">${spark(pid)}</td><td class="num hide-s">${lastG ? fmt(S.gamePoints(lastG, sc)) : '—'}</td>
      <td class="num pts">${fmt((row.perPlayer.find(x => x.player === pid) || {}).pts || 0)}</td></tr>`;
  }).join('');
  const former = row.perPlayer.filter(p => !p.current && p.pts);
  const feed = D.stats.games.filter(g => ids.includes(g.player)).sort((a, b) => (b.ts + b.n).localeCompare(a.ts + a.n)).slice(0, 12)
    .map(r => `<tr><td class="dim" style="white-space:nowrap">${esc(day(r.ts))}</td><td class="fill">${pcell(r.player)}</td>
      <td>${U.champIcon(D, r.champ, 22)}</td><td class="num hide-s" style="white-space:nowrap">${r.k}/${r.d}/${r.a}</td>
      <td><span class="wl ${r.win ? 'w' : 'l'}">${r.win ? 'W' : 'L'}</span></td><td class="num pts">${fmt(S.gamePoints(r, sc))}</td></tr>`).join('');

  let h = (isMe ? announcement() : '') + `<section class="hero">
    <div class="eyebrow">${isMe ? 'Mein Team' : 'Manager'} · ${esc(tourLabel())}</div><h1>${esc(m.name)}</h1>
    <div class="sub">${row.rank === 1 && row.total > 0 ? 'Tabellenführer.' : ahead ? `${fmt(row.gap)} Punkte hinter Platz 1 · ${fmt(ahead.total - row.total)} hinter ${esc(ahead.name)}` : ''}</div>
    <div class="hero-stats">
      <div><div class="big-num" style="color:var(--gold-hi)">${row.rank}.</div><div class="k">Platz</div></div>
      <div><div class="big-num">${fmt(row.total)}</div><div class="k">Punkte</div></div>
      <div><div class="big-num">${fmt(wk.length ? wk.reduce((a, w) => a + w.pts, 0) / wk.length : 0)}</div><div class="k">Ø pro Woche</div></div>
      <div><div class="big-num">${ids.length}</div><div class="k">Spieler</div></div>
      ${best ? `<div><div class="big-num">${esc(U.playerName(D, best.player))}</div><div class="k">Bester Spieler</div></div>` : ''}
    </div>
    ${isMe ? '<div class="cta"><button class="btn" id="logout">Abmelden</button></div>' : ''}
  </section>`;
  if (isMe) h += pushCard();
  if (isMe && status() === 'done') {
    const tr = S.transferRules(L()), win = S.transferWindow(L()), n = pendingForMe();
    if (tr.enabled || tr.freeAgents) h += `<a class="note" href="#/transfers" style="display:flex;align-items:center;gap:12px;color:inherit">
      <span>⇄</span><div style="flex:1">${n ? `<b>${n} Trade-Angebot${n > 1 ? 'e' : ''} für dich.</b> ` : ''}Transfers: ${tr.mode === 'always' || win.open ? '<b>Fenster offen</b>' : 'Fenster zu'} — Trades und Free Agents.</div><span class="btn gold sm">Öffnen</span></a>`;
  }
  h += `<div class="grid g-main" style="margin-bottom:18px">
    <div class="stack">${card('Kader', ids.length ? `<table><thead><tr><th>Spieler</th><th class="hide-s">Nächstes Spiel</th><th class="hide-s">Form</th><th class="num hide-s">Letztes</th><th class="num">Punkte</th></tr></thead><tbody>${rosterRows}</tbody></table>`
        : `<div class="empty">Noch kein Kader. ${status() !== 'done' ? '<a href="#/draft">Zum Draft →</a>' : ''}</div>`)}
      ${wk.length ? card('Punkte pro Woche', `<div class="card-b"><div class="bars">${wk.map(w => `<div class="b"><b>${Math.round(w.pts)}</b><i style="height:${Math.max(2, w.pts / max * 92)}px"></i><span>${esc(blockLabel(w.block).replace('Woche ', 'W'))}</span></div>`).join('')}</div></div>`) : ''}
      ${former.length ? card('Ehemalige Spieler', '<table><tbody>' + former.map(p => `<tr><td class="fill">${pcell(p.player, { photo: true })}</td><td class="num pts">${fmt(p.pts)}</td></tr>`).join('') + '</tbody></table>', 'Punkte bis zum Wechsel') : ''}</div>
    <div class="stack">${matchupCard(id)}${card('Nächste Spiele', upH)}${card('Platzierung', standMini(id))}</div></div>`;
  if (feed) h += card(isMe ? 'Letzte Spiele deiner Spieler' : 'Letzte Spiele', `<table><tbody>${feed}</tbody></table>`);
  return h;
}
function standMini(id) {
  return '<table><tbody>' + standings().map(r => `<tr class="click ${r.manager === id ? 'me' : ''}" data-href="#/manager/${esc(r.manager)}">
    <td class="rank r${r.rank}" style="width:34px;font-size:16px">${r.rank}</td><td class="fill"><b>${esc(r.name)}</b></td><td class="num pts">${fmt(r.total)}</td></tr>`).join('') + '</tbody></table>';
}

// ── draft ─────────────────────────────────────────────────────────────────
function viewDraft() {
  const lg = L(), st = status(), prog = S.draftProgress(lg), clock = S.currentPicker(lg);
  const mine = st === 'live' && clock === me();
  const picks = lg.draft.picks || [], last = picks[picks.length - 1];
  const dl = LIVE.deadline, timer = lg.draft.timer || {};
  let h = announcement();
  h += `<div class="clock ${mine ? 'mine' : ''}">
    <div style="min-width:0"><div class="eyebrow">${st === 'lobby' ? 'Anmeldung' : st === 'done' ? 'Draft abgeschlossen' : `Runde ${prog.round} · Pick ${prog.done + 1}/${prog.total}`}</div>
    <div class="who">${st === 'lobby' ? 'Gleich geht\'s los' : st === 'done' ? 'Kader stehen' : mine ? 'Du bist dran' : esc(mgrName(clock)) + ' ist dran'}</div>
    <div class="meta">${st === 'lobby' ? `${(lg.managers || []).length} Manager dabei — der Admin startet den Draft. Stell dir schon mal deine ★ Watchlist zusammen.`
      : last ? `Letzter Pick: <b>${esc(mgrName(last.manager))}</b> → ${esc(U.playerName(D, last.player))}${last.by === 'auto' ? ' <span class="pill">Auto</span>' : ''}` : ''}</div></div>
    <div class="timer">${st === 'live' && dl ? `<div class="big-num" id="countdown" data-deadline="${esc(dl)}">—</div><div class="meta">${timer.mode === 'auto' ? 'bis Auto-Pick' : 'Zeit für den Pick'}</div>`
      : st === 'live' && last && last.at ? `<div class="big-num" id="elapsed" data-since="${esc(last.at)}">0:00</div><div class="meta">seit letztem Pick</div>` : ''}</div>
  </div>`;

  const own = S.ownership(lg);
  const idx = new Map(D.players.players.map(p => [p.id, p]));
  const level = st === 'live' ? S.relaxLevel(lg, idx, me()) : 0;
  const q = ui.q.toLowerCase();
  let list = D.players.players.filter(p =>
    (!ui.role || p.role === ui.role) && (!ui.team || p.team === ui.team) &&
    (!ui.avail || !own.has(p.id)) && (!ui.watch || watch.includes(p.id)) &&
    (!q || [p.name, p.realName, p.team, (D.T.get(p.team) || {}).name].join(' ').toLowerCase().includes(q)));
  list.sort((a, b) => season(b.id)[ui.sort] - season(a.id)[ui.sort] || a.name.localeCompare(b.name));
  const rows = list.map(p => {
    const taken = own.get(p.id), se = season(p.id);
    const why = st === 'live' && !taken ? S.pickError(lg, idx, me(), p.id, level) : null;
    const cell = taken ? `<span class="pill">${esc(mgrName(taken))}</span>`
      : st !== 'live' ? ''
      : why ? `<span class="why" title="${esc(why)}">${esc(why.length > 18 ? why.slice(0, 17) + '…' : why)}</span>`
      : `<button class="btn gold sm" data-pick="${esc(p.id)}" ${mine && !ui.busy ? '' : 'disabled'}>Pick</button>`;
    return `<tr class="${taken ? 'gone' : ''}"><td style="width:30px"><button class="star ${watch.includes(p.id) ? 'on' : ''}" data-star="${esc(p.id)}" title="Watchlist">★</button></td>
      <td class="fill">${pcell(p.id, { photo: true, real: true })}</td><td class="hide-s">${spark(p.id)}</td>
      <td class="num hide-s">${fmt(se.avg)}</td><td class="num pts">${fmt(se.pts)}</td><td class="num" style="width:1%">${cell}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">nichts gefunden</td></tr>';
  const teamOpts = '<option value="">Alle Teams</option>' + D.teams.teams.map(t => `<option value="${esc(t.code)}" ${ui.team === t.code ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const pool = card('Spieler', `<div class="card-b" style="display:flex;flex-direction:column;gap:10px">
      <div class="row" style="flex-wrap:wrap"><input id="q" placeholder="Spieler, Name, Team …" value="${esc(ui.q)}" style="flex:1;min-width:160px"><select id="teamf">${teamOpts}</select></div>
      <div class="row" style="flex-wrap:wrap;justify-content:space-between">
        <div class="chips">${['', ...(lg.roster.slots || [])].map(r => `<button class="chip ${ui.role === r ? 'on' : ''}" data-role="${r}">${r || 'Alle'}</button>`).join('')}</div>
        <div class="chips"><button class="chip ${ui.avail ? 'on' : ''}" id="tAvail">Nur frei</button><button class="chip ${ui.watch ? 'on' : ''}" id="tWatch">★ Watchlist</button></div></div></div>
    <table class="pool"><thead><tr><th></th><th>Spieler</th><th class="hide-s">Form</th>
      <th class="num hide-s"><a href="#" data-sort="avg" style="color:${ui.sort === 'avg' ? 'var(--text)' : 'inherit'}">Ø</a></th>
      <th class="num"><a href="#" data-sort="pts" style="color:${ui.sort === 'pts' ? 'var(--text)' : 'inherit'}">Pkt</a></th><th></th></tr></thead><tbody>${rows}</tbody></table>`,
    `${list.length} Spieler · Punkte aus ${esc(tourLabel())}`);

  let side = card('Dein Kader', rosterList(S.rosters(lg)[me()] || []), `${(S.rosters(lg)[me()] || []).length}/${S.rosterSize(lg)}`);
  side += card('Bester Verfügbarer', '<div class="best">' + (lg.roster.slots || []).map(r => {
    const p = D.players.players.filter(x => x.role === r && !own.has(x.id)).sort((a, b) => season(b.id).pts - season(a.id).pts)[0];
    return p ? `<div class="r"><span class="rl">${r}</span><span style="flex:1;min-width:0">${pcell(p.id, { photo: true })}</span><span class="pts">${fmt(season(p.id).pts)}</span></div>` : '';
  }).join('') + '</div>', 'pro Rolle');
  const wl = watch.filter(id => D.P.has(id));
  side += card('★ Watchlist', wl.length ? '<div class="best">' + wl.map((id, i) => `<div class="r" style="${own.has(id) ? 'opacity:.4' : ''}"><span class="rl" style="width:22px;color:var(--dim)">${i + 1}</span><span style="flex:1;min-width:0">${pcell(id, { photo: true })}</span>${own.has(id) ? `<span class="pill">${esc(mgrName(own.get(id)))}</span>` : '<span class="pill teal">frei</span>'}</div>`).join('') + '</div>'
    : '<div class="empty">Markier Spieler mit ★.</div>', timer.mode === 'auto' ? 'Reihenfolge = dein Auto-Pick' : '');
  const log = picks.slice().reverse().slice(0, 12).map((p, i) => `<div><span class="n">#${picks.length - i}</span><b>${esc(mgrName(p.manager))}</b><span class="dim">→</span>${pcell(p.player)}${p.by === 'auto' ? '<span class="pill">Auto</span>' : p.by === 'admin' ? '<span class="pill">Admin</span>' : ''}</div>`).join('');
  side += card('Verlauf', `<div class="log">${log || '<div class="dim">noch keine Picks</div>'}</div>`);
  if (st === 'lobby') side = card('Dabei', '<div class="best">' + (lg.managers || []).map(m => `<div class="r"><span class="userchip" style="padding:0;border:0;background:none"><span class="av">${esc(initials(m.name))}</span></span><b style="flex:1">${esc(m.name)}</b>${m.id === me() ? '<span class="pill gold">Du</span>' : ''}</div>`).join('') + '</div>', `${(lg.managers || []).length} Manager`) + side;

  h += `<div class="grid g-main"><div class="stack">${pool}</div><div class="stack">${side}</div></div>`;
  if (st !== 'lobby') h += `<div style="margin-top:18px">${card('Draft Board', board(), 'Snake: jede zweite Runde rückwärts')}</div>`;
  return h;
}
function rosterList(ids) {
  const lg = L(), used = new Set();
  let h = '<div class="best">';
  for (const s of lg.roster.slots || []) {
    const pid = ids.find(p => !used.has(p) && (D.P.get(p) || {}).role === s);
    if (pid) used.add(pid);
    h += `<div class="r"><span class="rl">${s}</span><span style="flex:1;min-width:0">${pid ? pcell(pid, { photo: true }) : '<span class="dim">offen</span>'}</span>${pid ? `<span class="pts">${fmt(season(pid).pts)}</span>` : ''}</div>`;
  }
  for (let i = 0; i < (lg.roster.bench || 0); i++) {
    const pid = ids.find(p => !used.has(p));
    if (pid) used.add(pid);
    h += `<div class="r"><span class="rl" style="color:var(--muted)">BANK</span><span style="flex:1;min-width:0">${pid ? pcell(pid, { photo: true }) : '<span class="dim">offen</span>'}</span>${pid ? `<span class="pts">${fmt(season(pid).pts)}</span>` : ''}</div>`;
  }
  return h + '</div>';
}
function board() {
  const lg = L(), order = lg.draft.order || [], picks = lg.draft.picks || [], n = order.length;
  if (!n) return '<div class="empty">—</div>';
  let h = `<div class="card-b"><div class="board" style="grid-template-columns:34px repeat(${n},minmax(130px,1fr))"><div></div>`;
  for (const id of order) h += `<div class="hd ${id === me() ? 'me' : ''}">${esc(mgrName(id))}</div>`;
  for (let r = 0; r < S.rosterSize(lg); r++) {
    h += `<div class="rd">${r + 1}</div>`;
    const cells = [];
    for (let i = 0; i < n; i++) cells[(lg.draft.snake && r % 2 === 1) ? n - 1 - i : i] = r * n + i;
    for (let c = 0; c < n; c++) {
      const no = cells[c], p = picks[no];
      if (p) {
        const pl = D.P.get(p.player) || {};
        h += `<a class="slotc" href="#/spieler/${esc(p.player)}" style="color:inherit">${pl.photo ? `<img class="ph" src="${esc(pl.photo)}" alt="" loading="lazy">` : ''}
          <div class="t"><b>${esc(pl.name || p.player)}</b><span>${logo(pl.team, 14)} ${esc(pl.role || '')} · #${no + 1}</span></div></a>`;
      } else {
        const now = no === picks.length && status() === 'live';
        h += `<div class="slotc ${now ? 'now' : 'empty'}"><div class="t"><b>${now ? 'am Zug' : ''}</b><span>#${no + 1}</span></div></div>`;
      }
    }
  }
  return h + '</div></div>';
}

// ── transfers (trades + free agents) ──────────────────────────────────────
const tx = { partner: '', give: [], get: [], faOut: '', faIn: '', faQ: '', busy: false };
function pendingForMe() {
  return ((L() && L().trades) || []).filter(t => t.status === 'proposed' && t.to === me()).length;
}
function viewTransfers() {
  const lg = L(), tr = S.transferRules(lg), win = S.transferWindow(lg);
  const d = iso => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const ros = S.rosters(lg), mine = ros[me()] || [], own = S.ownership(lg);
  const done = status() === 'done';
  const statusLine = !done ? 'Transfers gibt es erst nach dem Draft.'
    : !tr.enabled && !tr.freeAgents ? 'In dieser Liga sind keine Transfers erlaubt.'
    : tr.mode === 'always' ? 'Transfers sind jederzeit möglich.'
    : win.open ? `Transferfenster <b>${esc(win.current.label || '')}</b> ist offen bis <b>${d(win.current.to)}</b>.`
    : win.next ? `Transferfenster ist zu — das nächste öffnet am <b>${d(win.next.from)}</b>${win.next.label ? ' (' + esc(win.next.label) + ')' : ''}.`
    : 'Transferfenster ist zu.';
  const open = done && (tr.mode === 'always' || win.open);
  let h = pageHead('Mein Team', 'Transfers') + `<div class="note">${statusLine}</div>`;

  // offers
  const trades = (lg.trades || []).filter(t => t.from === me() || t.to === me());
  const pl = ids => ids.map(id => pcell(id, { photo: true })).join('<br>');
  const offerRows = trades.filter(t => ['proposed', 'agreed'].includes(t.status)).map(t => {
    const incoming = t.to === me();
    const actions = t.status === 'agreed' ? '<span class="pill gold">wartet auf Admin</span>'
      : incoming ? `<button class="btn gold sm" data-tx="accept" data-id="${esc(t.id)}" ${open ? '' : 'disabled'}>Annehmen</button> <button class="btn sm" data-tx="decline" data-id="${esc(t.id)}">Ablehnen</button>`
      : `<button class="btn sm" data-tx="cancel" data-id="${esc(t.id)}">Zurückziehen</button>`;
    return `<tr><td style="white-space:nowrap"><b>${incoming ? 'von ' + esc(mgrName(t.from)) : 'an ' + esc(mgrName(t.to))}</b><div class="dim" style="font-size:11px">${d(t.at)}</div></td>
      <td class="fill"><div class="dim" style="font-size:11px">${incoming ? 'du bekommst' : 'du gibst'}</div>${pl(incoming ? t.give : t.give)}</td>
      <td class="fill"><div class="dim" style="font-size:11px">${incoming ? 'du gibst' : 'du bekommst'}</div>${pl(t.get)}</td>
      <td class="num" style="white-space:nowrap">${actions}</td></tr>`;
  }).join('');
  if (tr.enabled) h += card('Angebote', offerRows ? `<table class="tight"><tbody>${offerRows}</tbody></table>` : '<div class="empty">Keine offenen Angebote.</div>');

  // new trade
  if (tr.enabled && done) {
    const others = (lg.managers || []).filter(m => m.id !== me());
    const theirs = tx.partner ? ros[tx.partner] || [] : [];
    const pick = (ids, key) => ids.map(id => `<label class="row" style="padding:7px 0;gap:10px;margin:0;color:var(--text);cursor:pointer;border-bottom:1px solid var(--line)">
        <input type="checkbox" data-txpick="${key}" value="${esc(id)}" style="width:auto" ${tx[key].includes(id) ? 'checked' : ''}><span style="flex:1;min-width:0">${pcell(id, { photo: true })}</span><span class="pts">${fmt(season(id).pts)}</span></label>`).join('');
    h += card('Neuer Trade', `<div class="card-b">
      <label>Mit wem?</label><select id="txPartner" style="width:100%"><option value="">— Manager wählen —</option>${others.map(m => `<option value="${esc(m.id)}" ${tx.partner === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      ${tx.partner ? `<div class="grid g-2" style="margin-top:14px;gap:14px"><div><div class="eyebrow" style="margin-bottom:6px">Du gibst</div>${pick(mine, 'give')}</div>
        <div><div class="eyebrow" style="margin-bottom:6px">Du bekommst</div>${pick(theirs, 'get')}</div></div>
        <div class="row" style="margin-top:14px;flex-wrap:wrap"><button class="btn gold" data-tx="propose" ${open && tx.give.length && tx.get.length ? '' : 'disabled'}>Angebot schicken</button>
        <span class="muted" style="font-size:12px">${tr.equalCount ? 'Gleich viele Spieler auf beiden Seiten. ' : ''}${tr.rosterRules ? 'Jede Rolle muss danach besetzt bleiben.' : ''}</span></div>` : ''}
    </div>`);
  }

  // free agents
  if (tr.freeAgents && done) {
    const wk = S.weekKey(new Date().toISOString());
    const used = (lg.swaps || []).filter(x => x.manager === me() && x.by === 'self' && x.at && S.weekKey(x.at) === wk).length;
    const left = tr.perWeek > 0 ? Math.max(0, tr.perWeek - used) : null;
    const q = tx.faQ.toLowerCase();
    const free = D.players.players.filter(p => !own.has(p.id) && (!q || [p.name, p.realName, p.team, p.role].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => season(b.id).pts - season(a.id).pts).slice(0, 25);
    h += card('Free Agents', `<div class="card-b">
      <label>Abgeben</label><select id="faOut" style="width:100%"><option value="">— eigenen Spieler wählen —</option>${mine.map(id => `<option value="${esc(id)}" ${tx.faOut === id ? 'selected' : ''}>${esc((D.P.get(id) || {}).name || id)} · ${esc((D.P.get(id) || {}).team || '')} ${esc((D.P.get(id) || {}).role || '')}</option>`).join('')}</select>
      <label>Holen</label><input id="faQ" placeholder="Freie Spieler suchen …" value="${esc(tx.faQ)}" style="width:100%"></div>
      <table class="pool"><tbody>${free.map(p => `<tr><td class="fill">${pcell(p.id, { photo: true, real: true })}</td><td class="num pts">${fmt(season(p.id).pts)}</td>
        <td class="num" style="width:1%"><button class="btn gold sm" data-tx="fa" data-id="${esc(p.id)}" ${open && tx.faOut && left !== 0 ? '' : 'disabled'}>Holen</button></td></tr>`).join('') || '<tr><td class="empty">kein freier Spieler gefunden</td></tr>'}</tbody></table>`,
      left === null ? 'unbegrenzt' : `noch ${left} diese Woche`);
  }

  // history (league-wide, newest first)
  const hist = [];
  for (const t of lg.trades || []) if (t.status === 'accepted') hist.push({ at: t.decidedAt || t.at, html: `<b>${esc(mgrName(t.from))}</b> ⇄ <b>${esc(mgrName(t.to))}</b>: ${t.give.map(id => esc(U.playerName(D, id))).join(', ')} ⇄ ${t.get.map(id => esc(U.playerName(D, id))).join(', ')}` });
  for (const x of lg.swaps || []) hist.push({ at: x.at || '', html: `<b>${esc(mgrName(x.manager))}</b>: ${esc(U.playerName(D, x.out))} → ${esc(U.playerName(D, x.in))} ${x.by === 'self' ? '<span class="pill">Free Agent</span>' : '<span class="pill">Admin</span>'}` });
  hist.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  h += card('Alle Transfers der Liga', hist.length ? '<div class="log">' + hist.slice(0, 40).map(x => `<div><span class="n" style="width:70px">${x.at ? esc(day(x.at)) : '—'}</span><span>${x.html}</span></div>`).join('') + '</div>' : '<div class="empty">noch keine</div>');
  return h;
}
async function txAction(body, okText) {
  if (tx.busy) return;
  tx.busy = true;
  try {
    await api('/api/trade', { method: 'POST', body });
    toast(okText);
    if (body.action === 'propose') { tx.give = []; tx.get = []; }
    if (body.action === 'freeAgent') { tx.faOut = ''; }
  } catch (e) { toast(`<span style="color:#ffb1b3">${esc(e.message)}</span>`); }
  finally { tx.busy = false; await pollLive(true); }
}

// ── players & teams (public data; ownership only when logged in) ──────────
function viewPlayers() {
  const showOwner = loggedIn();
  let list = D.players.players.map(p => ({ p, s: season(p.id) }));
  if (ui.prole) list = list.filter(x => x.p.role === ui.prole);
  const key = { pts: x => x.s.pts, avg: x => x.s.avg, kda: x => (x.s.k + x.s.a) / Math.max(1, x.s.d), games: x => x.s.games }[ui.psort];
  list.sort((a, b) => key(b) - key(a) || a.p.name.localeCompare(b.p.name));
  const th = (k, l, cls) => `<th class="num ${cls || ''}"><a href="#" data-psort="${k}" style="color:${ui.psort === k ? 'var(--text)' : 'inherit'}">${l}</a></th>`;
  const rows = list.map((x, i) => {
    const s = x.s, o = showOwner && owner(x.p.id);
    return `<tr class="click" data-href="#/spieler/${esc(x.p.id)}"><td class="rank" style="width:36px;font-size:15px">${i + 1}</td>
      <td class="fill">${pcell(x.p.id, { photo: true, real: true })}</td>
      ${showOwner ? `<td class="hide-s">${o ? `<span class="pill gold">${esc(mgrName(o))}</span>` : '<span class="pill">frei</span>'}</td>` : ''}
      <td class="hide-s">${spark(x.p.id)}</td><td class="num hide-s">${s.games}</td><td class="num hide-s">${f1((s.k + s.a) / Math.max(1, s.d))}</td>
      <td class="num hide-s">${fmt(s.avg)}</td><td class="num pts">${fmt(s.pts)}</td></tr>`;
  }).join('');
  const chips = `<div class="chips">${['', 'TOP', 'JNG', 'MID', 'BOT', 'SUP'].map(r => `<button class="chip ${ui.prole === r ? 'on' : ''}" data-prole="${r}">${r || 'Alle'}</button>`).join('')}</div>`;
  return pageHead(esc(tourLabel()), 'Spieler', chips) + card('Alle Spieler', `<table><thead><tr><th>#</th><th>Spieler</th>${showOwner ? '<th class="hide-s">Manager</th>' : ''}<th class="hide-s">Form</th>
    ${th('games', 'Sp.', 'hide-s')}${th('kda', 'KDA', 'hide-s')}${th('avg', 'Ø', 'hide-s')}${th('pts', 'Punkte')}</tr></thead><tbody>${rows}</tbody></table>`, `${list.length} Spieler`);
}

function viewPlayer(id) {
  const p = D.P.get(id);
  if (!p) return card('Spieler', '<div class="empty">Spieler nicht gefunden.</div>');
  const s = season(id), g = Math.max(1, s.games), t = D.T.get(p.team), o = loggedIn() && owner(id), sc = scoring();
  const nm = nextMatch(p.team);
  const champs = {};
  for (const r of s.rows) { const c = champs[r.champ] || (champs[r.champ] = { n: 0, w: 0, pts: 0 }); c.n++; if (r.win) c.w++; c.pts += S.gamePoints(r, sc); }
  const cp = Object.entries(champs).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  const oppOf = {};
  for (const r of D.stats.games) if (r.team !== p.team) oppOf[r.game] = r.team;
  const recent = s.rows.slice(-15), max = Math.max(10, ...recent.map(r => S.gamePoints(r, sc)));
  const chart = recent.length ? `<div class="bars">${recent.map(r => { const v = S.gamePoints(r, sc);
    return `<div class="b"><b>${Math.round(v)}</b><i style="height:${Math.max(2, v / max * 92)}px;${r.win ? '' : 'background:linear-gradient(180deg,#ff8a8d,#c2464a)'}"></i><span>${esc((oppOf[r.game] || '').slice(0, 4))}</span></div>`; }).join('')}</div>` : '<div class="empty">keine Spiele</div>';
  let h = `<section class="card" style="margin-bottom:18px"><div class="phero">${t && t.logo ? `<img class="teamlogo" src="${esc(t.logo)}" alt="">` : ''}
      ${p.photo ? `<img class="photo" src="${esc(p.photo)}" alt="">` : ''}
      <div class="info"><div class="eyebrow">${esc(p.role)} · <a href="#/team/${esc(p.team)}" style="color:inherit">${esc(t ? t.name : p.team)}</a></div>
        <h1>${esc(p.name)}</h1><div class="muted" style="margin-top:4px">${esc(p.realName || '')}</div>
        <div class="row" style="margin-top:12px;flex-wrap:wrap">
          ${loggedIn() ? (o ? `<a class="pill gold" href="#/manager/${esc(o)}">Kader von ${esc(mgrName(o))}</a>` : '<span class="pill teal">frei</span>') : ''}
          ${nm ? `<span class="pill">Nächstes Spiel: ${esc(dt(nm.start))} vs ${esc(opp(nm, p.team))}</span>` : ''}
        </div></div></div>
    <div class="kpis">
      <div><div class="k">Punkte</div><div class="v" style="color:var(--gold-hi)">${fmt(s.pts)}</div></div>
      <div><div class="k">Ø / Spiel</div><div class="v">${fmt(s.avg)}</div></div>
      <div><div class="k">Spiele</div><div class="v">${s.games}</div></div>
      <div><div class="k">Bilanz</div><div class="v">${s.wins}–${s.games - s.wins}</div></div>
      <div><div class="k">Ø K/D/A</div><div class="v">${f1(s.k / g)}/${f1(s.d / g)}/${f1(s.a / g)}</div></div>
      <div><div class="k">Ø CS</div><div class="v">${Math.round(s.cs / g)}</div></div></div></section>`;
  const cpH = cp.length ? '<table><tbody>' + cp.map(([c, v]) => `<tr><td class="fill">${U.champIcon(D, c, 28)} <b>${esc((D.champs.names || {})[c] || c)}</b></td>
    <td class="num dim">${v.n}×</td><td class="num">${Math.round(v.w / v.n * 100)}%</td><td class="num pts">${fmt(v.pts / v.n)}</td></tr>`).join('') + '</tbody></table>' : '<div class="empty">—</div>';
  const log = s.rows.slice().reverse().map(r => `<tr><td class="dim" style="white-space:nowrap">${esc(day(r.ts))}</td>
    <td>${logo(oppOf[r.game], 20)} <span class="hide-s">${esc(oppOf[r.game] || '')}</span></td>
    <td>${U.champIcon(D, r.champ, 24)} <span class="hide-s">${esc((D.champs.names || {})[r.champ] || r.champ)}</span></td>
    <td class="num" style="white-space:nowrap">${r.k}/${r.d}/${r.a}</td><td class="num hide-s">${r.cs}</td>
    <td><span class="wl ${r.win ? 'w' : 'l'}">${r.win ? 'W' : 'L'}</span>${r.corrected ? ' <span class="pill" title="vom Admin korrigiert">korr.</span>' : ''}</td>
    <td class="num pts">${fmt(S.gamePoints(r, sc))}</td></tr>`).join('');
  h += `<div class="grid g-2" style="margin-bottom:18px">${card('Form', `<div class="card-b">${chart}</div>`, 'letzte 15 Spiele')}${card('Champions', cpH, 'Spiele · Winrate · Ø Pkt')}</div>`;
  return h + card('Alle Spiele', s.rows.length ? `<table class="tight"><thead><tr><th>Datum</th><th>Gegner</th><th>Champ</th><th class="num">K/D/A</th><th class="num hide-s">CS</th><th></th><th class="num">Pkt</th></tr></thead><tbody>${log}</tbody></table>` : '<div class="empty">keine Spiele</div>');
}

function viewTeams() {
  return pageHead(esc(tourLabel()), 'Teams') + '<div class="grid g-teams">' + D.teams.teams.map(t => {
    const rec = teamRecord(t.code), nm = nextMatch(t.code);
    return `<a class="card tcard" href="#/team/${esc(t.code)}"><div class="top"><img src="${esc(t.logo)}" alt=""><div style="min-width:0"><div class="eyebrow" style="font-size:12px">${esc(t.code)}</div><h3>${esc(t.name)}</h3></div></div>
      <div class="foot">${avatars(D.players.players.filter(p => p.team === t.code).map(p => p.id), 7)}<span class="num"><b>${rec.w}–${rec.l}</b></span></div>
      ${nm ? `<div class="foot" style="font-size:12px;color:var(--muted)">Nächstes: ${esc(dt(nm.start))} vs ${esc(opp(nm, t.code))}</div>` : ''}</a>`;
  }).join('') + '</div>';
}
function viewTeam(code) {
  const t = D.T.get(code);
  if (!t) return card('Team', '<div class="empty">Team nicht gefunden.</div>');
  const rec = teamRecord(code), showOwner = loggedIn();
  const ros = '<table><tbody>' + D.players.players.filter(p => p.team === code).map(p => {
    const o = showOwner && owner(p.id);
    return `<tr class="click" data-href="#/spieler/${esc(p.id)}"><td class="fill">${pcell(p.id, { photo: true, real: true })}</td>
      ${showOwner ? `<td class="hide-s">${o ? `<span class="pill gold">${esc(mgrName(o))}</span>` : '<span class="pill">frei</span>'}</td>` : ''}<td class="num pts">${fmt(season(p.id).pts)}</td></tr>`;
  }).join('') + '</tbody></table>';
  const ev = (D.schedule.events || []).filter(e => e.teams.some(x => x.code === code)).reverse();
  const res = ev.map(e => `<div class="row" style="padding:11px 16px;border-bottom:1px solid var(--line);justify-content:space-between;flex-wrap:wrap">
    ${matchLine(e, code)}<span class="dim" style="font-size:12px">${esc(blockLabel(e.block))} · ${esc(day(e.start))}</span></div>`).join('');
  return `<section class="hero" style="display:flex;align-items:center;gap:24px"><img src="${esc(t.logo)}" alt="" style="width:96px;height:96px;object-fit:contain;position:relative;z-index:1">
      <div style="position:relative;z-index:1"><div class="eyebrow">${esc(t.code)} · ${esc(tourLabel())}</div><h1>${esc(t.name)}</h1><div class="sub">Bilanz <b>${rec.w}–${rec.l}</b> in Serien</div></div></section>
    <div class="grid g-2">${card('Kader', ros)}${card('Spiele', res || '<div class="empty">—</div>')}</div>`;
}

function viewRules() {
  const lg = L(), s = lg.scoring;
  const rows = [['Kill', s.kill], ['Tod', s.death], ['Assist', s.assist], ['CS', `${String(s.cs10).replace('.', ',')} (= ${Math.round(s.cs10 * 100)} pro 100)`], ['Sieg', s.win]]
    .map(([k, v]) => `<tr><td>${k}</td><td class="num pts">${typeof v === 'number' ? (v > 0 ? '+' : '') + String(v).replace('.', ',') : v}</td></tr>`).join('');
  const t = lg.draft.timer || {};
  return pageHead('So funktioniert\'s', 'Regeln') + `<div class="grid g-2">
    ${card('Punkte pro Spiel', `<table><tbody>${rows}</tbody></table>`)}
    ${card('Kader', `<div class="card-b muted" style="line-height:1.7"><b style="color:var(--text)">${S.rosterSize(lg)} Spieler</b> pro Manager: je einer auf ${esc((lg.roster.slots || []).join(', '))} plus ${lg.roster.bench || 0} Bank.<br>
      Höchstens <b style="color:var(--text)">${lg.roster.maxPerTeam} Spieler</b> vom selben LEC-Team. Alle gedrafteten Spieler zählen — auch die Bank.<br>
      Gibt es für dich keinen regelkonformen Pick mehr, lockert sich für diesen einen Pick das Team-Limit — der Draft bleibt nie hängen.</div>`)}
    ${card('Draft', `<div class="card-b muted" style="line-height:1.7"><b style="color:var(--text)">Snake Draft:</b> Runde 1 in fester Reihenfolge, Runde 2 rückwärts, und so weiter.<br>
      ${t.mode === 'auto' ? `Pick-Timer: <b style="color:var(--text)">${t.seconds} s</b>, danach Auto-Pick — erst aus deiner ★ Watchlist, sonst der beste Verfügbare.<br>` : t.mode === 'soft' ? `Pick-Timer: ${t.seconds} s (nur Anzeige).<br>` : ''}
      Nach dem letzten Pick sperrt der Draft automatisch.</div>`)}
    ${card('Tabelle', `<div class="card-b muted" style="line-height:1.7"><b style="color:var(--text)">Punkte:</b> Summe aller Punkte deiner Spieler.<br>
      <b style="color:var(--text)">Head-to-Head:</b> jede LEC-Woche spielst du gegen einen anderen Manager — mehr Punkte in der Woche gewinnt.<br>
      Wechsel und Trades zählen ab ihrem Datum; vorherige Punkte bleiben beim alten Manager.</div>`)}
    ${card('Transfers', (() => { const tr = S.transferRules(lg), w = S.transferWindow(lg);
      return `<div class="card-b muted" style="line-height:1.7">${tr.enabled ? '<b style="color:var(--text)">Trades:</b> zwei Manager einigen sich, fertig' + (tr.adminApproval ? ' (plus Freigabe durch den Admin)' : '') + '.<br>' : 'Keine Trades.<br>'}
        ${tr.freeAgents ? `<b style="color:var(--text)">Free Agents:</b> ungedraftete Spieler gegen eigene tauschen${tr.perWeek ? `, ${tr.perWeek}× pro Woche` : ''}.<br>` : ''}
        ${tr.mode === 'always' ? 'Jederzeit möglich.' : `Nur in Transferfenstern${w.open ? ' — gerade offen.' : w.next ? ' — nächstes ab ' + new Date(w.next.from).toLocaleDateString('de-DE') + '.' : '.'}`}
        ${tr.rosterRules ? '<br>Nach jedem Transfer muss jede Rolle besetzt bleiben.' : ''} Punkte zählen ab dem Transfer.</div>`; })())}
    ${card('Daten', `<div class="card-b muted" style="line-height:1.7">Stats kommen von der offiziellen lolesports-API, automatisch <b style="color:var(--text)">2× täglich</b>.
      Sieger pro Spiel werden aus den offiziellen Serienergebnissen abgeleitet. Passwort vergessen? Dem Admin Bescheid geben.</div>`)}
  </div>`;
}

// ── live ──────────────────────────────────────────────────────────────────
const live = { data: null, at: 0, err: null, busy: false };
async function gw(op, params) {
  const r = await fetch(GW + op + '?' + new URLSearchParams(Object.assign({ hl: 'de-DE' }, params)), { headers: { 'x-api-key': GW_KEY } });
  if (!r.ok) throw new Error('lolesports ' + r.status);
  return (await r.json()).data;
}
function stamp(ms) {
  const d = new Date(ms); d.setMilliseconds(0); d.setSeconds(d.getSeconds() - d.getSeconds() % 10);
  return d.toISOString().replace('.000Z', 'Z');
}
async function feedJson(url) {
  const r = await fetch(url).catch(() => null);
  if (!r || !r.ok) return null;          // 400 = "that time is not available yet"
  const t = await r.text();
  try { return t ? JSON.parse(t) : null; } catch (e) { return null; }
}
// The live feed lags behind the broadcast by a few minutes - measured
// 2026-10-02 on a running match: startingTime 30-180 s back answered HTTP 400,
// 300 s back worked and returned every frame up to the newest one. And a
// request WITHOUT startingTime returns the first frames of the game (0 gold,
// 0 kills) - useless for live. So: walk back until the feed answers, take the
// last frame, and remember the lag that worked for the next refresh.
const feedLag = {};
async function gameFrame(gameId, atIso) {
  if (atIso) {
    const w = await feedJson(`${FEED}window/${gameId}?startingTime=${atIso}`);
    return w && w.frames && w.frames.length ? { meta: w.gameMetadata, frame: w.frames[w.frames.length - 1] } : null;
  }
  const ladder = [60, 120, 180, 240, 300, 420, 600, 900];
  const start = Math.max(0, ladder.indexOf(feedLag[gameId] || 60) - 1);
  for (const back of ladder.slice(start)) {
    const w = await feedJson(`${FEED}window/${gameId}?startingTime=${stamp(Date.now() - back * 1000)}`);
    if (w && w.frames && w.frames.length) {
      feedLag[gameId] = back;
      const frame = w.frames[w.frames.length - 1];
      return { meta: w.gameMetadata, frame, lagMin: Math.max(0, Math.round((Date.now() - new Date(frame.rfc460Timestamp).getTime()) / 60000)) };
    }
  }
  return null;
}
// all games in progress (LEC only unless ?all=1); ?game=<id>&at=<iso> replays one
async function loadLive(params) {
  const out = [];
  if (params.game) {
    const g = await gameFrame(params.game, params.at);
    if (g) out.push({ league: 'Replay', block: '', game: g, number: 1, teams: D.teams.teams });
    return out;
  }
  const evs = ((await gw('getLive')).schedule.events || []).filter(e => e.state === 'inProgress' && e.type === 'match' && (params.all || (e.league && e.league.slug === 'lec')));
  for (const e of evs) {
    const det = (await gw('getEventDetails', { id: e.match ? e.match.id : e.id })).event;
    const games = ((det.match || {}).games || []).filter(x => x.state === 'inProgress');
    for (const gm of games) {
      const g = await gameFrame(gm.id);
      if (g) out.push({ league: e.league ? e.league.name : '', block: e.blockName || '', game: g, number: gm.number, teams: (det.match || {}).teams || [] });
    }
  }
  return out;
}
function refreshLive(force) {
  if (live.busy || (!force && Date.now() - live.at < 15000)) return;
  live.busy = true;
  const params = Object.fromEntries(new URLSearchParams((location.hash.split('?')[1]) || ''));
  loadLive(params).then(d => { live.data = d; live.err = null; }).catch(e => { live.err = e.message; live.data = live.data || []; })
    .finally(() => { live.busy = false; live.at = Date.now(); if (path() === '/live') render(); });
}
function viewLive() {
  if (!live.data && !live.err) { refreshLive(true); return pageHead('Live', 'Live') + card('Live', '<div class="empty">lade Live-Daten …</div>'); }
  const own = loggedIn() ? S.ownership(L()) : new Map();
  const sc = scoring();
  const lag = Math.max(0, ...(live.data || []).map(x => x.game.lagMin || 0));
  let h = pageHead('<span class="live-dot"></span>&nbsp; Live-Punkte', 'Live', `<span class="dim" style="font-size:12px">alle 20 s · Stand vor ${lag || '<1'} min (die Live-Daten hängen dem Stream etwas hinterher)</span>`);
  if (live.err) h += `<div class="msg err">Live-Daten nicht ladbar: ${esc(live.err)}</div>`;
  if (!live.data || !live.data.length) return h + card('Gerade läuft nichts', `<div class="empty">Kein LEC-Spiel live.${upcomingEvents()[0] ? ' Nächstes: ' + esc(dt(upcomingEvents()[0].start)) : ''}</div>`) + seasonFeed();
  const byMgr = {};
  let games = '';
  for (const lg of live.data) {
    const { meta, frame } = lg.game;
    const teamSide = side => {
      const md = meta[side + 'TeamMetadata'], fr = frame[side + 'Team'];
      const team = (lg.teams || []).find(t => t.id === md.esportsTeamId);
      const pm = Object.fromEntries(md.participantMetadata.map(x => [x.participantId, x]));
      const rows = fr.participants.map(p => {
        const m = pm[p.participantId] || {}, pid = m.esportsPlayerId;
        const pts = S.gamePoints({ k: p.kills, d: p.deaths, a: p.assists, cs: p.creepScore, win: false }, sc);
        const o = own.get(pid);
        if (o) byMgr[o] = (byMgr[o] || 0) + pts;
        return `<tr class="${o && o === me() ? 'me' : ''}"><td class="fill">${D.P.has(pid) ? pcell(pid, { photo: true }) : `<b>${esc(m.summonerName || '?')}</b>`}</td>
          <td>${U.champIcon(D, m.championId, 24)}</td><td class="num" style="white-space:nowrap">${p.kills}/${p.deaths}/${p.assists}</td>
          <td class="num hide-s">${p.creepScore}</td>${loggedIn() ? `<td class="hide-s">${o ? `<span class="pill gold">${esc(mgrName(o))}</span>` : ''}</td>` : ''}<td class="num pts">${fmt(pts)}</td></tr>`;
      }).join('');
      const name = team ? `${team.code && D.T.has(team.code) ? logo(team.code, 24) + ' ' : ''}${esc(team.name || team.code)}` : (side === 'blue' ? 'Blaue Seite' : 'Rote Seite');
      return card(name, `<table class="tight"><tbody>${rows}</tbody></table>`, `${fr.totalKills} K · ${(fr.totalGold / 1000).toFixed(1).replace('.', ',')}k · ${fr.towers} T · ${fr.barons} B`);
    };
    games += `<div class="eyebrow" style="margin:6px 0 10px">${esc(lg.league)} ${esc(lg.block)} · Spiel ${lg.number} · ${frame.gameState === 'finished' ? 'beendet' : 'läuft'}</div>
      <div class="grid g-2" style="margin-bottom:18px">${teamSide('blue')}${teamSide('red')}</div>`;
  }
  if (loggedIn() && Object.keys(byMgr).length) {
    const rows = Object.entries(byMgr).sort((a, b) => b[1] - a[1]).map(([m, p]) => `<tr class="${m === me() ? 'me' : ''}"><td class="fill"><b>${esc(mgrName(m))}</b></td><td class="num pts">+${fmt(p)}</td></tr>`).join('');
    h += `<div style="margin-bottom:18px">${card('Live-Punkte der Manager', `<table><tbody>${rows}</tbody></table>`, 'ohne Siegpunkte — die kommen nach Spielende')}</div>`;
  }
  return h + games;
}
async function checkLiveBadge() {
  try {
    liveNow = ((await gw('getLive')).schedule.events || []).filter(e => e.state === 'inProgress' && e.league && e.league.slug === 'lec');
    chrome();
  } catch (e) {}
}

// ── push ──────────────────────────────────────────────────────────────────
function pushCard() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return /iPhone|iPad/.test(navigator.userAgent)
      ? '<div class="note">📲 Für Benachrichtigungen auf dem iPhone: <b>Teilen → Zum Home-Bildschirm</b>, dann die App von dort öffnen.</div>' : '';
  }
  const on = store.get('lf.push', false);
  return `<div class="note" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span>🔔</span>
    <div style="flex:1;min-width:200px">${on ? 'Benachrichtigungen sind an — du bekommst eine Nachricht, wenn du im Draft dran bist.' : 'Benachrichtigungen, wenn du im Draft dran bist — auch wenn die Seite zu ist.'}</div>
    ${on ? '<button class="btn sm" id="pushTest">Test senden</button><button class="btn sm" id="pushOff">Aus</button>' : '<button class="btn gold sm" id="pushOn">Aktivieren</button>'}</div>`;
}
async function enablePush() {
  const reg = await navigator.serviceWorker.register('sw.js');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt.');
  const { key } = await api('/api/push/key');
  if (!key) throw new Error('Push ist auf dem Server noch nicht eingerichtet.');
  const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((key.length + 3) % 4)), c => c.charCodeAt(0));
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
  await api('/api/push', { method: 'POST', body: { subscription: sub.toJSON() } });
  store.set('lf.push', true);
}
async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) { await api('/api/push', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
  store.set('lf.push', false);
}

// ── routing & chrome ──────────────────────────────────────────────────────
const PRIVATE = /^\/(mein-team|draft|manager\/.+|regeln|transfers)$/;
const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  draft: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  players: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M22 20c0-3-2-5-5-5.5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  live: '<circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>',
};
const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${ICONS[n]}</svg>`;
function path() { return ((location.hash || '#/').replace(/^#/, '').split('?')[0]) || '/'; }
function nav() {
  const liveDot = liveNow.length ? '<span class="live-dot"></span>' : '';
  if (!loggedIn()) return [['#/', 'Saison', 'home', /^\/?$/], ['#/live', 'Live' + liveDot, 'live', /^\/live/], ['#/teams', 'Teams', 'shield', /^\/team/], ['#/spieler', 'Spieler', 'players', /^\/spieler/]];
  return [['#/', 'Übersicht', 'home', /^\/?$/], ['#/mein-team', 'Mein Team' + (pendingForMe() ? '<span class="live-dot" style="background:var(--gold);animation:none"></span>' : ''), 'user', /^\/(mein-team|manager\/.+|transfers)$/],
    ['#/draft', 'Draft' + (status() === 'live' ? '<span class="live-dot"></span>' : ''), 'draft', /^\/draft$/],
    ['#/live', 'Live' + liveDot, 'live', /^\/live/], ['#/spieler', 'Spieler', 'players', /^\/spieler/], ['#/teams', 'Teams', 'shield', /^\/team/], ['#/regeln', 'Regeln', null, /^\/regeln$/]];
}
function chrome() {
  if (!D) return;
  const p = path(), items = nav();
  $('nav').innerHTML = items.map(([h, l, , re]) => `<a href="${h}" class="${re.test(p) ? 'on' : ''}">${l}</a>`).join('');
  $('tabbar').innerHTML = items.filter(n => n[2]).slice(0, 6).map(([h, l, ic, re]) => `<a href="${h}" class="${re.test(p) ? 'on' : ''}">${icon(ic)}${l}</a>`).join('');
  $('user').innerHTML = loggedIn()
    ? `<a class="userchip" href="#/mein-team"><span class="av">${esc(initials(LIVE.me.name))}</span><span class="hide-s">${esc(LIVE.me.name)}</span></a>`
    : (p === '/' ? '' : `<a class="btn sm" href="#/">Einloggen</a>`);
  if (D.teams.league && D.teams.league.logo) { $('brandlogo').src = D.teams.league.logo; $('brandlogo').hidden = false; }
  $('footmeta').innerHTML = D.stats.updated ? `Daten: lolesports · Stand ${esc(new Date(D.stats.updated * 1000).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }))}${loggedIn() ? ' · <a href="#/regeln">Regeln</a>' : ''} · <a href="#/admin">Admin</a>` : '';
  const mine = loggedIn() && status() === 'live' && S.currentPicker(L()) === me();
  $('turnbar').className = 'turnbar' + (mine ? ' on' : '');
  $('turnbar').innerHTML = mine ? (p === '/draft' ? 'Du bist dran — wähle deinen Spieler' : 'Du bist dran! <a href="#/draft">Jetzt picken →</a>') : '';
  const title = { '/': loggedIn() ? 'Übersicht' : 'Saison', '/draft': 'Draft', '/spieler': 'Spieler', '/teams': 'Teams', '/regeln': 'Regeln', '/mein-team': 'Mein Team', '/live': 'Live', '/admin': 'Admin', '/transfers': 'Transfers' }[p] || '';
  document.title = (mine ? '▶ Du bist dran · ' : '') + 'LEC Fantasy' + (title ? ' — ' + title : '');
  if (mine && !wasMyTurn) yourTurn();
  wasMyTurn = !!mine;
}

function render() {
  if (!D) return;
  const p = path();
  const typing = document.activeElement && document.activeElement.id;
  const caret = typing && document.activeElement.selectionStart;
  if (p === '/admin') { chrome(); if (window.LECAdmin) window.LECAdmin.render($('view'), { D, WORKER, U, S }); return; }
  if (window.LECAdmin) window.LECAdmin.leave();
  let m, html;
  if ((m = p.match(/^\/join\/([\w-]+)$/))) html = viewJoin(m[1]);
  else if (session && !LIVE) html = '<div class="empty">lädt …</div>';
  else if (PRIVATE.test(p) && !loggedIn()) html = viewLanding();
  else if (p === '/' || p === '/login') html = loggedIn() ? viewHome() : viewLanding();
  else if (p === '/draft') html = viewDraft();
  else if (p === '/mein-team') html = viewMine();
  else if (p === '/transfers') html = viewTransfers();
  else if (p === '/spieler') html = viewPlayers();
  else if (p === '/teams') html = viewTeams();
  else if (p === '/regeln') html = viewRules();
  else if (p === '/live') html = viewLive();
  else if ((m = p.match(/^\/spieler\/([\w-]+)$/))) html = viewPlayer(m[1]);
  else if ((m = p.match(/^\/team\/([\w-]+)$/))) html = viewTeam(m[1]);
  else if ((m = p.match(/^\/manager\/([\w-]+)$/))) html = viewManager(m[1], m[1] === me());
  else html = card('Nicht gefunden', '<div class="empty"><a href="#/">Zur Startseite</a></div>');
  $('view').innerHTML = html;
  chrome();
  bind();
  if ((m = p.match(/^\/join\/([\w-]+)$/))) bindJoin(m[1]);
  if (routeKey !== p) { routeKey = p; window.scrollTo(0, 0); }
  if (typing && $(typing)) { const el = $(typing); el.focus(); try { el.setSelectionRange(caret, caret); } catch (e) {} }
  tick();
}

function bind() {
  document.querySelectorAll('[data-href]').forEach(el => el.onclick = e => { if (!e.target.closest('a,button')) location.hash = el.dataset.href; });
  document.querySelectorAll('a.plink').forEach(a => a.onclick = e => { e.preventDefault(); location.hash = '#/spieler/' + a.dataset.pid; });
  bindLogin();
  const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
  on('q', 'oninput', e => { ui.q = e.target.value; render(); });
  on('teamf', 'onchange', e => { ui.team = e.target.value; render(); });
  on('tAvail', 'onclick', () => { ui.avail = !ui.avail; render(); });
  on('tWatch', 'onclick', () => { ui.watch = !ui.watch; render(); });
  on('logout', 'onclick', () => logout());
  on('pushOn', 'onclick', async () => { unlockAudio(); try { await enablePush(); toast('Benachrichtigungen an ✓'); } catch (e) { toast(`<span style="color:#ffb1b3">${esc(e.message)}</span>`); } render(); });
  on('pushOff', 'onclick', async () => { await disablePush(); render(); });
  on('pushTest', 'onclick', async () => { try { const r = await api('/api/push/test', { method: 'POST' }); toast(r.sent ? 'Test gesendet ✓' : 'Kein Gerät erreicht — bitte neu aktivieren.'); } catch (e) { toast(esc(e.message)); } });
  document.querySelectorAll('[data-role]').forEach(b => b.onclick = () => { ui.role = b.dataset.role; render(); });
  document.querySelectorAll('[data-prole]').forEach(b => b.onclick = () => { ui.prole = b.dataset.prole; render(); });
  document.querySelectorAll('[data-table]').forEach(b => b.onclick = () => { ui.table = b.dataset.table; render(); });
  document.querySelectorAll('[data-sort]').forEach(b => b.onclick = e => { e.preventDefault(); ui.sort = b.dataset.sort; render(); });
  document.querySelectorAll('[data-psort]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); ui.psort = b.dataset.psort; render(); });
  document.querySelectorAll('[data-star]').forEach(b => b.onclick = () => {
    const id = b.dataset.star;
    watch = watch.includes(id) ? watch.filter(x => x !== id) : watch.concat(id);
    store.set('lf.watch', watch);
    syncQueue();
    render();
  });
  document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => doPick(b.dataset.pick));
  on('txPartner', 'onchange', e => { tx.partner = e.target.value; tx.get = []; render(); });
  on('faOut', 'onchange', e => { tx.faOut = e.target.value; render(); });
  on('faQ', 'oninput', e => { tx.faQ = e.target.value; render(); });
  document.querySelectorAll('[data-txpick]').forEach(c => c.onchange = () => {
    const k = c.dataset.txpick;
    tx[k] = c.checked ? tx[k].concat(c.value) : tx[k].filter(x => x !== c.value);
    render();
  });
  document.querySelectorAll('[data-tx]').forEach(b => b.onclick = () => {
    const a = b.dataset.tx, id = b.dataset.id;
    if (a === 'propose') return txAction({ action: 'propose', to: tx.partner, give: tx.give, get: tx.get }, 'Angebot verschickt.');
    if (a === 'accept' && confirm('Trade annehmen?')) return txAction({ action: 'respond', id, accept: true }, 'Trade angenommen.');
    if (a === 'decline') return txAction({ action: 'respond', id, accept: false }, 'Abgelehnt.');
    if (a === 'cancel') return txAction({ action: 'cancel', id }, 'Zurückgezogen.');
    if (a === 'fa' && confirm(`${U.playerName(D, tx.faOut)} abgeben und ${U.playerName(D, id)} holen?`)) return txAction({ action: 'freeAgent', out: tx.faOut, in: id }, `${esc(U.playerName(D, id))} ist jetzt in deinem Kader.`);
  });
}

// ── worker ────────────────────────────────────────────────────────────────
async function api(p, opt) {
  opt = opt || {};
  const headers = {};
  if (opt.body) headers['Content-Type'] = 'application/json';
  if (session) headers.Authorization = 'Bearer ' + session;
  let r;
  try { r = await fetch(WORKER + p, { method: opt.method || 'GET', headers, body: opt.body ? JSON.stringify(opt.body) : undefined }); }
  catch (e) { throw new Error('Server nicht erreichbar — Internet ok?'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && session && !/^\/api\/(login|join|invite)/.test(p)) logout(true);
    throw new Error(data.error || 'Fehler ' + r.status);
  }
  return data;
}
async function startSession(token) {
  session = token; store.set('lf.session', token);
  unlockAudio();
  await pollLive(true);
  syncQueue();
}
function logout(silent) {
  if (session && !silent) api('/api/logout', { method: 'POST' }).catch(() => {});
  session = ''; LIVE = null; if (D) D.league = null; store.del('lf.session');
  SEASON = new Map(); lastPickCount = null;
  if (!silent) location.hash = '#/';
  render();
}
let queueTimer = null;
function syncQueue() {
  if (!session) return;
  clearTimeout(queueTimer);
  queueTimer = setTimeout(() => api('/api/queue', { method: 'PUT', body: { queue: watch } }).catch(() => {}), 600);
}

async function doPick(id) {
  if (ui.busy) return;
  ui.busy = true; render();
  try {
    await api('/api/pick', { method: 'POST', body: { player: id } });
    toast(`<b>${esc(U.playerName(D, id))}</b> gehört dir.`, id);
  } catch (e) { toast(`<span style="color:#ffb1b3">${esc(e.message)}</span>`); }
  finally { ui.busy = false; await pollLive(true); }
}

let liveSig = '';
async function pollLive(force) {
  if (!session) return;
  try {
    const s = await api('/api/state');
    const picks = s.league.draft.picks || [];
    if (lastPickCount !== null && picks.length > lastPickCount) {
      for (const p of picks.slice(lastPickCount)) {
        if (p.manager !== s.me.id) toast(`<b>${esc((s.league.managers.find(m => m.id === p.manager) || {}).name || '?')}</b> pickt <b>${esc(U.playerName(D, p.player))}</b>${p.by === 'auto' ? ' (Auto)' : ''}`, p.player);
      }
    }
    lastPickCount = picks.length;
    const sig = JSON.stringify([s.league, s.me]);
    LIVE = s;
    if (D.league === null || sig !== liveSig || force) { D.league = s.league; SEASON = new Map(); liveSig = sig; render(); }
  } catch (e) { render(); }
}
function schedulePoll() {
  const st = loggedIn() ? status() : null;
  const delay = !session ? 60000 : st === 'live' ? (path() === '/draft' ? 4000 : 12000) : st === 'lobby' ? 30000 : 300000;
  setTimeout(async () => { if (!document.hidden) await pollLive(); schedulePoll(); }, delay);
}

// ── feedback ──────────────────────────────────────────────────────────────
function toast(html, pid) {
  const p = pid && D.P.get(pid), el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = (p && p.photo ? `<img class="ph" src="${esc(p.photo)}" alt="">` : '') + `<div>${html}</div>`;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 5000);
}
let actx = null;
function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) {} }
function yourTurn() {
  try {
    if (actx) [0, .14].forEach((t, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = i ? 1046 : 784;
      g.gain.setValueAtTime(.0001, actx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(.18, actx.currentTime + t + .02);
      g.gain.exponentialRampToValueAtTime(.0001, actx.currentTime + t + .35);
      o.connect(g).connect(actx.destination); o.start(actx.currentTime + t); o.stop(actx.currentTime + t + .4);
    });
    if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate([120, 60, 120]);
  } catch (e) {}
}
function tick() {
  const fmtS = s => s >= 3600 ? Math.floor(s / 3600) + 'h ' + String(Math.floor(s / 60) % 60).padStart(2, '0') + 'm' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const el = $('elapsed');
  if (el) el.textContent = fmtS(Math.max(0, Math.floor((Date.now() - new Date(el.dataset.since).getTime()) / 1000)));
  const cd = $('countdown');
  if (cd) {
    const left = Math.floor((new Date(cd.dataset.deadline).getTime() - Date.now()) / 1000);
    cd.textContent = left > 0 ? fmtS(left) : '0:00';
    cd.style.color = left <= 15 ? 'var(--loss)' : '';
  }
}

// ── boot ──────────────────────────────────────────────────────────────────
(async function boot() {
  try { D = await U.load(); }
  catch (e) { $('view').innerHTML = card('Fehler', '<div class="empty">Daten konnten nicht geladen werden.</div>'); return; }
  rebuild();
  render();
  window.addEventListener('hashchange', () => { joinInfo = null; render(); if (path() === '/live') refreshLive(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollLive(); });
  setInterval(tick, 1000);
  setInterval(() => { if (path() === '/live' && !document.hidden) refreshLive(); }, 20000);
  setInterval(async () => { try { const league = D.league; D = await U.load(); D.league = league; rebuild(); render(); } catch (e) {} }, 180000);
  checkLiveBadge(); setInterval(checkLiveBadge, 120000);
  if (session) await pollLive(true);
  if (session && !LIVE) { session = ''; store.del('lf.session'); render(); }
  schedulePoll();
})();
})();
