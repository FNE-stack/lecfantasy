// ═══════════════════════════════════════════════════════════════════════════
// app.js — the whole site as one app with real URLs (#/spieler/<id> etc.),
// so every page links to every other, the back button works, and links can
// be shared. Rules come from scoring.js, data + display bits from common.js.
// Writes go only through the Worker; nothing here can write to the repo.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
'use strict';

const WORKER = 'https://lecfantasy-draft.fabian-neidl.workers.dev';
const U = window.LECUI, S = window.LECScoring, esc = U.esc, fmt = U.fmt;
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

let D = null;                 // static data from GitHub Pages
let LIVE = null;              // draft state from the Worker (fresher than Pages)
let session = store.get('lf.session', '');
let me = store.get('lf.me', '');
let SEASON = new Map();       // player id -> season aggregate, rebuilt on data change
let WEEK_OF = new Map();      // match id -> "Week 3"
let BLOCKS = [];              // ordered block names
const ui = { role: '', team: '', q: '', avail: true, watch: false, sort: 'pts', psort: 'pts', prole: '', busy: false };
let watch = new Set(store.get('lf.watch', []));
let lastPickCount = null, wasMyTurn = false, routeKey = '';

// ── data helpers ──────────────────────────────────────────────────────────
const L = () => (LIVE && LIVE.league) || D.league;
const draftOpen = () => !(L().draft && L().draft.completed);
const mgr = id => (L().managers || []).find(m => m.id === id);
const mgrName = id => { const m = mgr(id); return m ? m.name : id; };
const initials = n => String(n || '?').trim().slice(0, 1).toUpperCase();
const blockLabel = b => (b || '').replace(/^Week (\d+)$/, 'Woche $1').replace('Finals', 'Finale');
const season = id => { if (!SEASON.has(id)) SEASON.set(id, U.playerSeason(D, id)); return SEASON.get(id); };
const owner = id => S.ownership(L()).get(id) || null;
const dt = iso => new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const day = iso => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
const f1 = n => (Number(n) || 0).toFixed(1).replace('.', ',');
const tourLabel = () => (D.stats.tournament || '').replace(/^lec_/, '').replace(/_/g, ' ').toUpperCase();

function rebuild() {
  SEASON = new Map();
  WEEK_OF = new Map();
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
function nextMatch(code) {
  const now = Date.now();
  return (D.schedule.events || []).find(e => e.state !== 'completed'
    && new Date(e.start).getTime() > now - 3 * 3600e3 && e.teams.some(t => t.code === code)) || null;
}
function lastMatch(code) {
  const ev = (D.schedule.events || []).filter(e => e.state === 'completed' && e.teams.some(t => t.code === code));
  return ev[ev.length - 1] || null;
}
function opp(e, code) { const o = e.teams.find(t => t.code !== code); return o ? o.code : '?'; }

// points per block for any set of players
function weekly(ids) {
  const set = new Set(ids), sc = L().scoring, out = {};
  for (const b of BLOCKS) out[b] = 0;
  for (const g of D.stats.games) {
    if (!set.has(g.player)) continue;
    const b = WEEK_OF.get(g.match);
    if (b) out[b] = (out[b] || 0) + S.gamePoints(g, sc);
  }
  return BLOCKS.map(b => ({ block: b, pts: Math.round(out[b] * 10) / 10 }));
}

function standings() {
  const rows = S.standings(L(), D.stats, D.P);
  const lastBlock = [...BLOCKS].reverse().find(b => D.stats.games.some(g => WEEK_OF.get(g.match) === b));
  const lead = rows.length ? rows[0].total : 0;
  return rows.map((r, i) => {
    const ids = r.perPlayer.map(p => p.player);
    const wk = lastBlock ? (weekly(ids).find(x => x.block === lastBlock) || {}).pts || 0 : 0;
    return { ...r, rank: i + 1, gap: lead - r.total, week: wk, ids };
  });
}

// ── small renderers ───────────────────────────────────────────────────────
const logo = (code, size) => U.teamLogo(D, code, size || 20);
function pcell(id, opts) { return U.playerCell(D, id, Object.assign({ link: true }, opts || {})); }
function avatars(ids, n) {
  return '<span class="avatars">' + ids.slice(0, n || 6).map(id => {
    const p = D.P.get(id);
    return p && p.photo ? `<img src="${esc(p.photo)}" alt="" title="${esc(p.name)}" loading="lazy">` : '';
  }).join('') + '</span>';
}
function spark(id, n) {
  const rows = season(id).rows.slice(-(n || 8));
  if (!rows.length) return '<span class="dim">—</span>';
  const sc = L().scoring;
  return '<span class="spark" title="letzte Spiele">' + rows.map(r => {
    const p = Math.max(0, S.gamePoints(r, sc));
    return `<i class="${r.win ? '' : 'l'}" style="height:${Math.max(3, Math.min(22, p / 2.6))}px"></i>`;
  }).join('') + '</span>';
}
function matchLine(e, code) {
  const [a, b] = e.teams;
  const done = e.state === 'completed';
  const score = done ? `<b class="num">${a.wins ?? 0}–${b.wins ?? 0}</b>` : `<span class="dim">Bo${e.bestOf}</span>`;
  const mark = code && done ? (e.teams.find(t => t.code === code) || {}).outcome === 'win'
    ? ' <span class="wl w">W</span>' : ' <span class="wl l">L</span>' : '';
  return `<span class="row" style="gap:8px">${logo(a.code, 22)}<b>${esc(a.code)}</b>${score}<b>${esc(b.code)}</b>${logo(b.code, 22)}${mark}</span>`;
}
function card(title, body, right) {
  return `<section class="card"><div class="card-h"><h2>${title}</h2>${right ? `<span class="r">${right}</span>` : ''}</div>${body}</section>`;
}

// ── views ─────────────────────────────────────────────────────────────────
function viewHome() {
  const st = standings();
  const prog = S.draftProgress(L());
  const open = draftOpen();
  const clock = S.currentPicker(L());
  const leader = st[0];
  const games = new Set(D.stats.games.map(g => g.game)).size;

  let h = `<section class="hero">
    <div class="eyebrow">${open ? '<span class="live-dot"></span>&nbsp; Draft läuft' : 'Saison läuft'} · ${esc(tourLabel())}</div>
    <h1>${esc(L().name || 'LEC Fantasy')}</h1>
    <div class="sub">${open
      ? (clock ? `Pick ${prog.done + 1} von ${prog.total} — <b>${esc(mgrName(clock))}</b> ist am Zug.` : 'Alle Picks vergeben.')
      : 'Kader stehen. Punkte kommen automatisch nach jedem LEC-Spieltag.'}</div>
    <div class="hero-stats">
      <div><div class="big-num">${(L().managers || []).length}</div><div class="k">Manager</div></div>
      <div><div class="big-num">${prog.done}/${prog.total}</div><div class="k">Picks</div></div>
      <div><div class="big-num">${games}</div><div class="k">Spiele erfasst</div></div>
      ${leader && leader.total > 0 ? `<div><div class="big-num" style="color:var(--gold-hi)">${esc(leader.name)}</div><div class="k">Tabellenführer</div></div>` : ''}
    </div>
    <div class="cta">${open ? '<a class="btn gold lg" href="#/draft">Zum Draft</a>' : '<a class="btn gold lg" href="#/mein-team">Mein Team</a>'}</div>
  </section>`;

  let rows = '';
  for (const r of st) {
    const cls = r.manager === me ? 'click me' : 'click';
    rows += `<tr class="${cls}" data-href="#/manager/${esc(r.manager)}">
      <td class="rank r${r.rank}">${r.rank}</td>
      <td class="fill"><div class="row" style="gap:10px;min-width:0"><span class="userchip" style="padding:0;border:0;background:none"><span class="av">${esc(initials(r.name))}</span></span>
        <div style="min-width:0"><b>${esc(r.name)}</b>${r.manager === me ? ' <span class="pill gold">Du</span>' : ''}
        <div class="hide-s" style="margin-top:3px">${r.ids.length ? avatars(r.ids, 6) : '<span class="dim" style="font-size:12px">noch kein Kader</span>'}</div></div></div></td>
      <td class="num hide-s">${fmt(r.week)}</td>
      <td class="num hide-s dim">${r.rank === 1 ? '—' : '−' + fmt(r.gap)}</td>
      <td class="num pts" style="font-size:16px">${fmt(r.total)}</td></tr>`;
  }
  const table = `<table><thead><tr><th>#</th><th>Manager</th><th class="num hide-s">Letzte Woche</th><th class="num hide-s">Rückstand</th><th class="num">Punkte</th></tr></thead><tbody>${rows}</tbody></table>`;

  const top = D.players.players.map(p => ({ p, s: season(p.id) })).sort((a, b) => b.s.pts - a.s.pts).slice(0, 6);
  const topH = '<table><tbody>' + top.map((x, i) => `<tr class="click" data-href="#/spieler/${esc(x.p.id)}">
    <td class="rank r${i + 1}" style="width:30px;font-size:16px">${i + 1}</td>
    <td class="fill">${pcell(x.p.id, { photo: true })}</td>
    <td class="num pts">${fmt(x.s.pts)}</td></tr>`).join('') + '</tbody></table>';

  const recent = (D.schedule.events || []).filter(e => e.state === 'completed').slice(-5).reverse();
  const recH = recent.length ? '<div>' + recent.map(e => `<div class="row" style="padding:11px 16px;border-bottom:1px solid var(--line);justify-content:space-between">
      ${matchLine(e)}<span class="dim" style="font-size:12px">${esc(blockLabel(e.block))}</span></div>`).join('') + '</div>'
    : '<div class="empty">noch keine Spiele</div>';

  h += `<div class="grid g-main">
    <div class="stack">${card('Tabelle', table, 'Klick → Kader')}</div>
    <div class="stack">
      ${card('Top Spieler', topH, `<a href="#/spieler">alle</a>`)}
      ${card('Letzte Ergebnisse', recH, `<a href="#/teams">Teams</a>`)}
    </div></div>`;
  return h;
}

// login / claim — used by the draft room and "Mein Team"
function loginPanel(intro) {
  const claimed = (LIVE && LIVE.claimed) || {};
  const slots = (L().managers || []).map(m => {
    const taken = claimed[m.id];
    return `<button data-slot="${esc(m.id)}" data-taken="${taken ? 1 : 0}">
      <span class="eyebrow" style="font-size:11px">${taken ? 'vergeben' : 'frei'}</span>
      <b>${esc(m.name)}</b><span class="muted" style="font-size:13px">${taken ? 'Einloggen →' : 'Das bin ich →'}</span></button>`;
  }).join('');
  return card('Einloggen', `<div class="card-b">
    <p class="muted" style="margin:0 0 14px">${intro}</p>
    ${LIVE ? `<div class="slotpick">${slots}</div>` : '<div class="dim">Verbinde mit dem Draft-Server …</div>'}
    <div id="authform"></div></div>`);
}
function bindLogin() {
  document.querySelectorAll('.slotpick button').forEach(b => b.onclick = () => authForm(b.dataset.slot, b.dataset.taken === '1'));
}
function authForm(slot, taken) {
  const m = mgr(slot);
  $('authform').innerHTML = `<div style="margin-top:18px;max-width:420px">
    <h3 style="font-size:22px">${taken ? 'Einloggen als ' + esc(m.name) : 'Slot übernehmen'}</h3>
    ${taken ? '' : `<label>Dein Name (sehen alle)</label><input id="dn" maxlength="32" value="${esc(m.name)}" style="width:100%">`}
    <label>Passwort${taken ? '' : ' — min. 6 Zeichen, gut merken'}</label>
    <input id="pw" type="password" autocomplete="${taken ? 'current' : 'new'}-password" style="width:100%">
    <div style="margin-top:14px"><button class="btn gold" id="doAuth">${taken ? 'Einloggen' : 'Übernehmen'}</button></div>
    <div id="authmsg" style="margin-top:12px"></div></div>`;
  $('pw').onkeydown = e => { if (e.key === 'Enter') $('doAuth').click(); };
  $('pw').focus();
  $('doAuth').onclick = async () => {
    const pw = $('pw').value;
    if (!pw) return;
    $('doAuth').disabled = true;
    try {
      const body = { manager: slot, password: pw };
      if (!taken) body.displayName = ($('dn').value || '').trim() || m.name;
      const res = await api(taken ? '/api/login' : '/api/claim', { method: 'POST', body });
      session = res.token; me = res.manager;
      store.set('lf.session', session); store.set('lf.me', me);
      unlockAudio();
      await pollLive(true);
      toast(`Willkommen, <b>${esc(mgrName(me))}</b>.`);
      render(true);
    } catch (e) {
      $('authmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`;
      $('doAuth').disabled = false;
    }
  };
}

function viewDraft() {
  const lg = L(), prog = S.draftProgress(lg), clock = S.currentPicker(lg);
  const open = draftOpen(), mine = open && me && clock === me;
  let h = '';

  // the clock
  const picks = (lg.draft && lg.draft.picks) || [];
  const last = picks[picks.length - 1];
  h += `<div class="clock ${mine ? 'mine' : ''}">
    <div><div class="eyebrow">${open ? (clock ? `Runde ${prog.round} · Pick ${prog.done + 1}/${prog.total}` : 'Alle Picks vergeben') : 'Draft abgeschlossen'}</div>
    <div class="who">${!open ? 'Kader stehen' : mine ? 'Du bist dran' : clock ? esc(mgrName(clock)) + ' ist dran' : '—'}</div>
    ${last ? `<div class="meta">Letzter Pick: <b>${esc(mgrName(last.manager))}</b> → ${esc(U.playerName(D, last.player))}</div>` : ''}</div>
    <div class="timer">${open && last && last.at ? `<div class="big-num" id="elapsed">0:00</div><div class="meta">seit letztem Pick</div>` : ''}
    ${me && open && 'Notification' in window && Notification.permission === 'default' ? '<button class="btn sm" id="notif" style="margin-top:8px">🔔 Benachrichtigen</button>' : ''}</div>
  </div>`;

  if (!me) h += loginPanel('Wähle deinen Slot. Beim ersten Mal legst du Namen und Passwort fest — wer zuerst kommt, hat den Slot.');

  // pool
  const own = S.ownership(lg);
  const idx = new Map(D.players.players.map(p => [p.id, p]));
  const q = ui.q.toLowerCase();
  let list = D.players.players.filter(p =>
    (!ui.role || p.role === ui.role) && (!ui.team || p.team === ui.team) &&
    (!ui.avail || !own.has(p.id)) && (!ui.watch || watch.has(p.id)) &&
    (!q || [p.name, p.realName, p.team, (D.T.get(p.team) || {}).name].join(' ').toLowerCase().includes(q)));
  list.sort((a, b) => season(b.id)[ui.sort] - season(a.id)[ui.sort] || a.name.localeCompare(b.name));

  const rows = list.map(p => {
    const why = open ? S.pickError(lg, idx, me || '_', p.id) : 'Draft gesperrt';
    const taken = own.get(p.id);
    const can = mine && !why && !ui.busy;
    const se = season(p.id);
    return `<tr class="${taken ? 'gone' : ''}">
      <td style="width:30px"><button class="star ${watch.has(p.id) ? 'on' : ''}" data-star="${esc(p.id)}" title="Watchlist">★</button></td>
      <td class="fill">${pcell(p.id, { photo: true, real: true })}</td>
      <td class="hide-s">${spark(p.id)}</td>
      <td class="num hide-s">${fmt(se.avg)}</td>
      <td class="num pts">${fmt(se.pts)}</td>
      <td class="num" style="width:1%">${taken ? `<span class="pill">${esc(mgrName(taken))}</span>`
        : !open ? ''
        : !me ? '<span class="pill teal">frei</span>'
        : why ? `<span class="why" title="${esc(why)}">${esc(why.length > 18 ? why.slice(0, 17) + '…' : why)}</span>`
        : `<button class="btn gold sm" data-pick="${esc(p.id)}" ${can ? '' : 'disabled'}>Pick</button>`}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">nichts gefunden</td></tr>';

  const roles = ['', ...(lg.roster.slots || [])];
  const teamOpts = '<option value="">Alle Teams</option>' + D.teams.teams.map(t => `<option value="${esc(t.code)}" ${ui.team === t.code ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const pool = card('Spieler', `<div class="card-b" style="display:flex;flex-direction:column;gap:10px">
      <div class="row" style="flex-wrap:wrap"><input id="q" placeholder="Spieler, Name, Team …" value="${esc(ui.q)}" style="flex:1;min-width:160px">
        <select id="teamf">${teamOpts}</select></div>
      <div class="row" style="flex-wrap:wrap;justify-content:space-between">
        <div class="chips">${roles.map(r => `<button class="chip ${ui.role === r ? 'on' : ''}" data-role="${r}">${r || 'Alle'}</button>`).join('')}</div>
        <div class="chips"><button class="chip ${ui.avail ? 'on' : ''}" id="tAvail">Nur frei</button><button class="chip ${ui.watch ? 'on' : ''}" id="tWatch">★ Watchlist</button></div>
      </div></div>
    <table class="pool"><thead><tr><th></th><th>Spieler</th><th class="hide-s">Form</th>
      <th class="num hide-s"><a href="#" data-sort="avg" style="color:${ui.sort === 'avg' ? 'var(--text)' : 'inherit'}">Ø</a></th>
      <th class="num"><a href="#" data-sort="pts" style="color:${ui.sort === 'pts' ? 'var(--text)' : 'inherit'}">Pkt</a></th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`, `${list.length} Spieler · Punkte aus ${esc(tourLabel())}`);

  // side: my roster, best available, watchlist, log
  let side = '';
  if (me) {
    const ros = S.rosters(lg)[me] || [];
    side += card('Dein Kader', rosterList(ros), `${ros.length}/${(lg.roster.slots || []).length + (lg.roster.bench || 0)}`);
  }
  const best = (lg.roster.slots || []).map(r => {
    const p = D.players.players.filter(x => x.role === r && !own.has(x.id)).sort((a, b) => season(b.id).pts - season(a.id).pts)[0];
    return p ? `<div class="r"><span class="rl">${r}</span><span class="fill" style="flex:1;min-width:0">${pcell(p.id, { photo: true })}</span><span class="pts">${fmt(season(p.id).pts)}</span></div>` : '';
  }).join('');
  side += card('Bester Verfügbarer', `<div class="best">${best}</div>`, 'pro Rolle');
  const wl = [...watch].filter(id => D.P.has(id));
  if (wl.length) {
    side += card('★ Watchlist', '<div class="best">' + wl.map(id => `<div class="r" style="${own.has(id) ? 'opacity:.4' : ''}"><span style="flex:1;min-width:0">${pcell(id, { photo: true })}</span>${own.has(id) ? `<span class="pill">${esc(mgrName(own.get(id)))}</span>` : '<span class="pill teal">frei</span>'}</div>`).join('') + '</div>');
  }
  const log = picks.slice().reverse().slice(0, 12).map((p, i) => `<div><span class="n">#${picks.length - i}</span><b>${esc(mgrName(p.manager))}</b><span class="dim">→</span>${pcell(p.player)}</div>`).join('');
  side += card('Verlauf', `<div class="log">${log || '<div class="dim">noch keine Picks</div>'}</div>`);

  h += `<div class="grid g-main"><div class="stack">${pool}</div><div class="stack">${side}</div></div>`;
  h += `<div style="margin-top:18px">${card('Draft Board', board(), 'Snake: Runde 2 läuft rückwärts')}</div>`;
  return h;
}

function rosterList(ids) {
  const lg = L(), slots = lg.roster.slots || [], bench = lg.roster.bench || 0, used = new Set();
  let h = '<div class="best">';
  for (const s of slots) {
    const pid = ids.find(p => !used.has(p) && (D.P.get(p) || {}).role === s);
    if (pid) used.add(pid);
    h += `<div class="r"><span class="rl">${s}</span><span style="flex:1;min-width:0">${pid ? pcell(pid, { photo: true }) : '<span class="dim">offen</span>'}</span>${pid ? `<span class="pts">${fmt(season(pid).pts)}</span>` : ''}</div>`;
  }
  for (let i = 0; i < bench; i++) {
    const pid = ids.find(p => !used.has(p));
    if (pid) used.add(pid);
    h += `<div class="r"><span class="rl" style="color:var(--muted)">BANK</span><span style="flex:1;min-width:0">${pid ? pcell(pid, { photo: true }) : '<span class="dim">offen</span>'}</span>${pid ? `<span class="pts">${fmt(season(pid).pts)}</span>` : ''}</div>`;
  }
  return h + '</div>';
}

function board() {
  const lg = L(), order = lg.draft.order || [], picks = lg.draft.picks || [];
  const rounds = (lg.roster.slots || []).length + (lg.roster.bench || 0);
  const n = order.length;
  let h = `<div class="card-b"><div class="board" style="grid-template-columns:34px repeat(${n},minmax(130px,1fr))"><div></div>`;
  for (const id of order) h += `<div class="hd ${id === me ? 'me' : ''}">${esc(mgrName(id))}</div>`;
  for (let r = 0; r < rounds; r++) {
    h += `<div class="rd">${r + 1}</div>`;
    const cells = [];
    for (let i = 0; i < n; i++) {
      const pickNo = r * n + i;                                   // order of play
      const col = (lg.draft.snake && r % 2 === 1) ? n - 1 - i : i; // which manager column
      cells[col] = pickNo;
    }
    for (let c = 0; c < n; c++) {
      const no = cells[c], p = picks[no];
      if (p) {
        const pl = D.P.get(p.player) || {};
        h += `<a class="slotc" href="#/spieler/${esc(p.player)}" style="color:inherit">${pl.photo ? `<img class="ph" src="${esc(pl.photo)}" alt="" loading="lazy">` : ''}
          <div class="t"><b>${esc(pl.name || p.player)}</b><span>${logo(pl.team, 14)} ${esc(pl.role || '')} · #${no + 1}</span></div></a>`;
      } else {
        const now = no === picks.length && draftOpen();
        h += `<div class="slotc ${now ? 'now' : 'empty'}"><div class="t"><b>${now ? 'am Zug' : ''}</b><span>#${no + 1}</span></div></div>`;
      }
    }
  }
  return h + '</div></div>';
}

function viewPlayers() {
  const own = S.ownership(L());
  let list = D.players.players.map(p => ({ p, s: season(p.id) }));
  if (ui.prole) list = list.filter(x => x.p.role === ui.prole);
  const key = { pts: x => x.s.pts, avg: x => x.s.avg, kda: x => (x.s.k + x.s.a) / Math.max(1, x.s.d), games: x => x.s.games }[ui.psort];
  list.sort((a, b) => key(b) - key(a) || a.p.name.localeCompare(b.p.name));
  const th = (k, l, cls) => `<th class="num ${cls || ''}"><a href="#" data-psort="${k}" style="color:${ui.psort === k ? 'var(--text)' : 'inherit'}">${l}</a></th>`;
  const rows = list.map((x, i) => {
    const s = x.s, g = Math.max(1, s.games), o = own.get(x.p.id);
    return `<tr class="click" data-href="#/spieler/${esc(x.p.id)}">
      <td class="rank" style="width:36px;font-size:15px">${i + 1}</td>
      <td class="fill">${pcell(x.p.id, { photo: true, real: true })}</td>
      <td class="hide-s">${o ? `<span class="pill gold">${esc(mgrName(o))}</span>` : '<span class="pill">frei</span>'}</td>
      <td class="hide-s">${spark(x.p.id)}</td>
      <td class="num hide-s">${s.games}</td>
      <td class="num hide-s">${f1((s.k + s.a) / Math.max(1, s.d))}</td>
      <td class="num hide-s">${fmt(s.avg)}</td>
      <td class="num pts">${fmt(s.pts)}</td></tr>`;
  }).join('');
  const chips = ['', ...(L().roster.slots || [])].map(r => `<button class="chip ${ui.prole === r ? 'on' : ''}" data-prole="${r}">${r || 'Alle'}</button>`).join('');
  return `<div class="row" style="justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <div><div class="eyebrow">${esc(tourLabel())}</div><h1 style="font-size:40px">Spieler</h1></div><div class="chips">${chips}</div></div>` +
    card('Alle Spieler', `<table><thead><tr><th>#</th><th>Spieler</th><th class="hide-s">Manager</th><th class="hide-s">Form</th>
      ${th('games', 'Sp.', 'hide-s')}${th('kda', 'KDA', 'hide-s')}${th('avg', 'Ø', 'hide-s')}${th('pts', 'Punkte')}</tr></thead><tbody>${rows}</tbody></table>`, `${list.length} Spieler`);
}

function viewPlayer(id) {
  const p = D.P.get(id);
  if (!p) return card('Spieler', '<div class="empty">Spieler nicht gefunden.</div>');
  const s = season(id), g = Math.max(1, s.games), t = D.T.get(p.team), o = owner(id), sc = L().scoring;
  const nm = nextMatch(p.team);
  // champion pool
  const champs = {};
  for (const r of s.rows) {
    const c = champs[r.champ] || (champs[r.champ] = { n: 0, w: 0, pts: 0 });
    c.n++; if (r.win) c.w++; c.pts += S.gamePoints(r, sc);
  }
  const cp = Object.entries(champs).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  const oppOf = {};
  for (const r of D.stats.games) if (r.team !== p.team) oppOf[r.game] = r.team;

  const recent = s.rows.slice(-15);
  const max = Math.max(10, ...recent.map(r => S.gamePoints(r, sc)));
  const chart = recent.length ? `<div class="bars">${recent.map(r => {
    const v = S.gamePoints(r, sc);
    return `<div class="b"><b>${Math.round(v)}</b><i style="height:${Math.max(2, v / max * 92)}px;${r.win ? '' : 'background:linear-gradient(180deg,#ff8a8d,#c2464a)'}"></i><span>${esc((oppOf[r.game] || '').slice(0, 4))}</span></div>`;
  }).join('')}</div>` : '<div class="empty">keine Spiele</div>';

  let h = `<section class="card" style="margin-bottom:18px">
    <div class="phero">${t && t.logo ? `<img class="teamlogo" src="${esc(t.logo)}" alt="">` : ''}
      ${p.photo ? `<img class="photo" src="${esc(p.photo)}" alt="">` : ''}
      <div class="info"><div class="eyebrow">${esc(p.role)} · ${esc(t ? t.name : p.team)}</div>
        <h1>${esc(p.name)}</h1><div class="muted" style="margin-top:4px">${esc(p.realName || '')}</div>
        <div class="row" style="margin-top:12px;flex-wrap:wrap">
          ${o ? `<a class="pill gold" href="#/manager/${esc(o)}">Kader von ${esc(mgrName(o))}</a>` : '<span class="pill teal">frei</span>'}
          ${nm ? `<span class="pill">Nächstes Spiel: ${esc(dt(nm.start))} vs ${esc(opp(nm, p.team))}</span>` : ''}
          ${watch.has(id) ? '<span class="pill gold">★ Watchlist</span>' : ''}
        </div></div></div>
    <div class="kpis">
      <div><div class="k">Punkte</div><div class="v" style="color:var(--gold-hi)">${fmt(s.pts)}</div></div>
      <div><div class="k">Ø / Spiel</div><div class="v">${fmt(s.avg)}</div></div>
      <div><div class="k">Spiele</div><div class="v">${s.games}</div></div>
      <div><div class="k">Bilanz</div><div class="v">${s.wins}–${s.games - s.wins}</div></div>
      <div><div class="k">Ø K/D/A</div><div class="v">${f1(s.k / g)}/${f1(s.d / g)}/${f1(s.a / g)}</div></div>
      <div><div class="k">Ø CS</div><div class="v">${Math.round(s.cs / g)}</div></div>
    </div></section>`;

  const cpH = cp.length ? '<table><tbody>' + cp.map(([c, v]) => `<tr><td class="fill">${U.champIcon(D, c, 28)} <b>${esc((D.champs.names || {})[c] || c)}</b></td>
    <td class="num dim">${v.n}×</td><td class="num">${Math.round(v.w / v.n * 100)}%</td><td class="num pts">${fmt(v.pts / v.n)}</td></tr>`).join('') + '</tbody></table>'
    : '<div class="empty">—</div>';
  const log = s.rows.slice().reverse().map(r => `<tr>
    <td class="dim" style="white-space:nowrap">${esc(day(r.ts))}</td>
    <td>${logo(oppOf[r.game], 20)} <span class="hide-s">${esc(oppOf[r.game] || '')}</span></td>
    <td>${U.champIcon(D, r.champ, 24)} <span class="hide-s">${esc((D.champs.names || {})[r.champ] || r.champ)}</span></td>
    <td class="num" style="white-space:nowrap">${r.k}/${r.d}/${r.a}</td>
    <td class="num hide-s">${r.cs}</td>
    <td><span class="wl ${r.win ? 'w' : 'l'}">${r.win ? 'W' : 'L'}</span></td>
    <td class="num pts">${fmt(S.gamePoints(r, sc))}</td></tr>`).join('');

  h += `<div class="grid g-2" style="margin-bottom:18px">${card('Form', `<div class="card-b">${chart}</div>`, 'letzte 15 Spiele')}${card('Champions', cpH, 'Spiele · Winrate · Ø Pkt')}</div>`;
  h += card('Alle Spiele', s.rows.length ? `<table class="tight"><thead><tr><th>Datum</th><th>Gegner</th><th>Champ</th><th class="num">K/D/A</th><th class="num hide-s">CS</th><th></th><th class="num">Pkt</th></tr></thead><tbody>${log}</tbody></table>` : '<div class="empty">keine Spiele</div>');
  return h;
}

function viewTeams() {
  const cards = D.teams.teams.map(t => {
    const rec = teamRecord(t.code), nm = nextMatch(t.code);
    const ids = D.players.players.filter(p => p.team === t.code).map(p => p.id);
    return `<a class="card tcard" href="#/team/${esc(t.code)}">
      <div class="top"><img src="${esc(t.logo)}" alt=""><div style="min-width:0"><div class="eyebrow" style="font-size:12px">${esc(t.code)}</div><h3>${esc(t.name)}</h3></div></div>
      <div class="foot">${avatars(ids, 7)}<span class="num"><b>${rec.w}–${rec.l}</b></span></div>
      ${nm ? `<div class="foot" style="font-size:12px;color:var(--muted)">Nächstes: ${esc(dt(nm.start))} vs ${esc(opp(nm, t.code))}</div>` : ''}</a>`;
  }).join('');
  return `<div style="margin-bottom:16px"><div class="eyebrow">${esc(tourLabel())}</div><h1 style="font-size:40px">Teams</h1></div><div class="grid g-teams">${cards}</div>`;
}

function viewTeam(code) {
  const t = D.T.get(code);
  if (!t) return card('Team', '<div class="empty">Team nicht gefunden.</div>');
  const rec = teamRecord(code), own = S.ownership(L());
  const ids = D.players.players.filter(p => p.team === code).map(p => p.id);
  const ros = '<table><tbody>' + ids.map(id => `<tr class="click" data-href="#/spieler/${esc(id)}">
    <td class="fill">${pcell(id, { photo: true, real: true })}</td>
    <td class="hide-s">${own.get(id) ? `<span class="pill gold">${esc(mgrName(own.get(id)))}</span>` : '<span class="pill">frei</span>'}</td>
    <td class="num pts">${fmt(season(id).pts)}</td></tr>`).join('') + '</tbody></table>';
  const ev = (D.schedule.events || []).filter(e => e.teams.some(x => x.code === code)).reverse();
  const res = ev.map(e => `<div class="row" style="padding:11px 16px;border-bottom:1px solid var(--line);justify-content:space-between;flex-wrap:wrap">
    ${matchLine(e, code)}<span class="dim" style="font-size:12px">${esc(blockLabel(e.block))} · ${esc(day(e.start))}</span></div>`).join('');
  return `<section class="hero" style="display:flex;align-items:center;gap:24px">
      <img src="${esc(t.logo)}" alt="" style="width:96px;height:96px;object-fit:contain;position:relative;z-index:1">
      <div style="position:relative;z-index:1"><div class="eyebrow">${esc(t.code)} · ${esc(tourLabel())}</div><h1>${esc(t.name)}</h1>
      <div class="sub">Bilanz <b>${rec.w}–${rec.l}</b> in Serien</div></div></section>
    <div class="grid g-2">${card('Kader', ros)}${card('Spiele', res || '<div class="empty">—</div>')}</div>`;
}

function viewManager(id, isMe) {
  const m = mgr(id);
  if (!m) return card('Manager', '<div class="empty">Manager nicht gefunden.</div>');
  const st = standings(), row = st.find(r => r.manager === id) || { total: 0, rank: '–', gap: 0, perPlayer: [], ids: [] };
  const ids = row.ids, sc = L().scoring;
  const wk = weekly(ids);
  const max = Math.max(10, ...wk.map(w => w.pts));
  const ahead = st[row.rank - 2];
  const best = row.perPlayer[0];

  // next matches that involve any of my players
  const teams = new Map();
  for (const pid of ids) { const p = D.P.get(pid); if (p) (teams.get(p.team) || teams.set(p.team, []).get(p.team)).push(pid); }
  const upcoming = (D.schedule.events || []).filter(e => e.state !== 'completed' && e.teams.some(t => teams.has(t.code))).slice(0, 6);
  const upH = upcoming.length ? upcoming.map(e => {
    const mine = e.teams.flatMap(t => teams.get(t.code) || []);
    return `<div class="row" style="padding:11px 16px;border-bottom:1px solid var(--line);justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div><div class="dim" style="font-size:12px">${esc(dt(e.start))} · ${esc(blockLabel(e.block))}</div>${matchLine(e)}</div>${avatars(mine, 5)}</div>`;
  }).join('') : `<div class="empty">${ids.length ? 'Noch keine Spiele angesetzt — sobald Riot den Spielplan veröffentlicht, stehen hier die nächsten Spiele deiner Spieler.' : 'Erst draften, dann gibt es Spiele.'}</div>`;

  const rosterRows = ids.map(pid => {
    const p = D.P.get(pid) || {}, s = season(pid), nm = nextMatch(p.team), lastG = s.rows[s.rows.length - 1];
    return `<tr class="click" data-href="#/spieler/${esc(pid)}">
      <td class="fill">${pcell(pid, { photo: true })}</td>
      <td class="hide-s dim" style="white-space:nowrap;font-size:12px">${nm ? esc(dt(nm.start)) + ' vs ' + esc(opp(nm, p.team)) : '—'}</td>
      <td class="hide-s">${spark(pid)}</td>
      <td class="num hide-s">${lastG ? fmt(S.gamePoints(lastG, sc)) : '—'}</td>
      <td class="num pts">${fmt(s.pts)}</td></tr>`;
  }).join('');

  const feed = D.stats.games.filter(g => ids.includes(g.player)).sort((a, b) => (b.ts + b.n).localeCompare(a.ts + a.n)).slice(0, 12)
    .map(r => `<tr><td class="dim" style="white-space:nowrap">${esc(day(r.ts))}</td><td class="fill">${pcell(r.player)}</td>
      <td>${U.champIcon(D, r.champ, 22)}</td><td class="num hide-s" style="white-space:nowrap">${r.k}/${r.d}/${r.a}</td>
      <td><span class="wl ${r.win ? 'w' : 'l'}">${r.win ? 'W' : 'L'}</span></td><td class="num pts">${fmt(S.gamePoints(r, sc))}</td></tr>`).join('');

  let h = `<section class="hero">
    <div class="eyebrow">${isMe ? 'Mein Team' : 'Manager'} · ${esc(tourLabel())}</div>
    <h1>${esc(m.name)}</h1>
    <div class="sub">${row.rank === 1 && row.total > 0 ? 'Tabellenführer.' : ahead ? `${fmt(row.gap)} Punkte hinter Platz 1 · ${fmt(ahead.total - row.total)} hinter ${esc(ahead.name)}` : ''}</div>
    <div class="hero-stats">
      <div><div class="big-num" style="color:var(--gold-hi)">${row.rank}.</div><div class="k">Platz</div></div>
      <div><div class="big-num">${fmt(row.total)}</div><div class="k">Punkte</div></div>
      <div><div class="big-num">${fmt(wk.length ? wk.reduce((a, w) => a + w.pts, 0) / Math.max(1, wk.filter(w => w.pts).length) : 0)}</div><div class="k">Ø pro Woche</div></div>
      <div><div class="big-num">${ids.length}</div><div class="k">Spieler</div></div>
      ${best ? `<div><div class="big-num">${esc(U.playerName(D, best.player))}</div><div class="k">Bester Spieler</div></div>` : ''}
    </div>
    ${isMe ? '<div class="cta"><button class="btn" id="logout">Abmelden</button></div>' : ''}
  </section>`;

  h += `<div class="grid g-main" style="margin-bottom:18px">
    <div class="stack">${card('Kader', ids.length ? `<table><thead><tr><th>Spieler</th><th class="hide-s">Nächstes Spiel</th><th class="hide-s">Form</th><th class="num hide-s">Letztes</th><th class="num">Punkte</th></tr></thead><tbody>${rosterRows}</tbody></table>`
        : `<div class="empty">Noch kein Kader. ${draftOpen() ? '<a href="#/draft">Zum Draft →</a>' : ''}</div>`)}
      ${card('Punkte pro Woche', wk.length ? `<div class="card-b"><div class="bars">${wk.map(w => `<div class="b"><b>${Math.round(w.pts)}</b><i style="height:${Math.max(2, w.pts / max * 92)}px"></i><span>${esc(blockLabel(w.block).replace('Woche ', 'W'))}</span></div>`).join('')}</div></div>` : '<div class="empty">—</div>')}</div>
    <div class="stack">${card('Nächste Spiele', upH)}${card('Platzierung', standMini(id))}</div></div>`;
  if (feed) h += card('Letzte Spiele deiner Spieler', `<table><tbody>${feed}</tbody></table>`);
  return h;
}

function standMini(id) {
  return '<table><tbody>' + standings().map(r => `<tr class="click ${r.manager === id ? 'me' : ''}" data-href="#/manager/${esc(r.manager)}">
    <td class="rank r${r.rank}" style="width:34px;font-size:16px">${r.rank}</td><td class="fill"><b>${esc(r.name)}</b></td><td class="num pts">${fmt(r.total)}</td></tr>`).join('') + '</tbody></table>';
}

function viewMine() {
  if (me && mgr(me)) return viewManager(me, true);
  return `<div style="margin-bottom:16px"><div class="eyebrow">Dein Bereich</div><h1 style="font-size:40px">Mein Team</h1></div>` +
    loginPanel('Logg dich ein, um deinen Kader, deine Punkte pro Woche und die nächsten Spiele deiner Spieler zu sehen.');
}

function viewRules() {
  const lg = L(), s = lg.scoring;
  const rows = [['Kill', s.kill], ['Tod', s.death], ['Assist', s.assist], ['CS', `${s.cs10} (= ${Math.round(s.cs10 * 100)} pro 100)`], ['Sieg', s.win]]
    .map(([k, v]) => `<tr><td>${k}</td><td class="num pts">${typeof v === 'number' ? (v > 0 ? '+' : '') + String(v).replace('.', ',') : v}</td></tr>`).join('');
  const slots = (lg.roster.slots || []).join(', ');
  return `<div style="margin-bottom:16px"><div class="eyebrow">So funktioniert's</div><h1 style="font-size:40px">Regeln</h1></div>
  <div class="grid g-2">
    ${card('Punkte pro Spiel', `<table><tbody>${rows}</tbody></table>`)}
    ${card('Kader', `<div class="card-b muted" style="line-height:1.7">
      <b style="color:var(--text)">${(lg.roster.slots || []).length + (lg.roster.bench || 0)} Spieler</b> pro Manager: je einer auf ${esc(slots)} plus ${lg.roster.bench || 0} Bank.<br>
      Höchstens <b style="color:var(--text)">${lg.roster.maxPerTeam} Spieler</b> vom selben LEC-Team.<br>
      Alle gedrafteten Spieler zählen — auch die Bank.</div>`)}
    ${card('Draft', `<div class="card-b muted" style="line-height:1.7">
      <b style="color:var(--text)">Snake Draft:</b> Runde 1 in fester Reihenfolge, Runde 2 rückwärts, und so weiter.<br>
      Jeder pickt selbst auf <a href="#/draft">Draft</a>. Der Server prüft jeden Pick (am Zug? frei? Rolle? Team-Limit?).<br>
      Nach dem letzten Pick sperrt der Draft automatisch.</div>`)}
    ${card('Daten', `<div class="card-b muted" style="line-height:1.7">
      Stats kommen von der offiziellen lolesports-API, automatisch <b style="color:var(--text)">2× täglich</b> (06:20 & 18:20 Uhr).<br>
      Sieger pro Spiel werden aus den offiziellen Serienergebnissen abgeleitet.<br>
      Passwort vergessen? Dem Host Bescheid geben — er gibt den Slot frei.</div>`)}
  </div>`;
}

// ── routing ───────────────────────────────────────────────────────────────
const NAV = [
  ['#/', 'Übersicht', 'home', /^\/?$/],
  ['#/mein-team', 'Mein Team', 'user', /^\/(mein-team|manager\/.+)$/],
  ['#/draft', 'Draft', 'draft', /^\/draft$/],
  ['#/spieler', 'Spieler', 'players', /^\/spieler/],
  ['#/teams', 'Teams', 'shield', /^\/team/],
  ['#/regeln', 'Regeln', 'book', /^\/regeln$/],
];
const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  draft: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  players: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M22 20c0-3-2-5-5-5.5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  book: '<path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-5"/>',
};
const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${ICONS[n]}</svg>`;

function path() { return (location.hash || '#/').replace(/^#/, '') || '/'; }

function chrome() {
  const p = path(), open = draftOpen();
  $('nav').innerHTML = NAV.map(([href, label, , re]) =>
    `<a href="${href}" class="${re.test(p) ? 'on' : ''}">${label}${href === '#/draft' && open ? '<span class="live-dot"></span>' : ''}</a>`).join('');
  $('tabbar').innerHTML = NAV.filter(n => n[2] !== 'book').map(([href, label, ic, re]) =>
    `<a href="${href}" class="${re.test(p) ? 'on' : ''}">${icon(ic)}${label}${href === '#/draft' && open ? '<span class="live-dot"></span>' : ''}</a>`).join('');
  $('user').innerHTML = me && mgr(me)
    ? `<a class="userchip" href="#/mein-team"><span class="av">${esc(initials(mgrName(me)))}</span><span class="hide-s">${esc(mgrName(me))}</span></a>`
    : `<a class="btn sm" href="#/mein-team">Einloggen</a>`;
  const lg = D.teams.league;
  if (lg && lg.logo) { $('brandlogo').src = lg.logo; $('brandlogo').hidden = false; }
  $('footmeta').innerHTML = D.stats.updated ? `Daten: lolesports · Stand ${esc(new Date(D.stats.updated * 1000).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }))} · <a href="#/regeln">Regeln</a> · <a href="draft.html">Admin</a>` : '';

  const mine = open && me && S.currentPicker(L()) === me;
  $('turnbar').className = 'turnbar' + (mine ? ' on' : '');
  $('turnbar').innerHTML = mine ? (p === '/draft' ? 'Du bist dran — wähle deinen Spieler' : 'Du bist dran! <a href="#/draft">Jetzt picken →</a>') : '';
  const title = { '/': 'Übersicht', '/draft': 'Draft', '/spieler': 'Spieler', '/teams': 'Teams', '/regeln': 'Regeln', '/mein-team': 'Mein Team' }[p] || '';
  document.title = (mine ? '▶ Du bist dran · ' : '') + 'LEC Fantasy' + (title ? ' — ' + title : '');
  if (mine && !wasMyTurn) yourTurn();
  wasMyTurn = !!mine;
}

function render(force) {
  if (!D) return;
  const p = path();
  // don't rebuild the page under someone's thumb while they type
  const typing = document.activeElement && document.activeElement.id;
  const caret = typing && document.activeElement.selectionStart;
  let m, html;
  if (p === '/' || p === '') html = viewHome();
  else if (p === '/draft') html = viewDraft();
  else if (p === '/mein-team') html = viewMine();
  else if (p === '/spieler') html = viewPlayers();
  else if (p === '/teams') html = viewTeams();
  else if (p === '/regeln') html = viewRules();
  else if ((m = p.match(/^\/spieler\/([\w-]+)$/))) html = viewPlayer(m[1]);
  else if ((m = p.match(/^\/team\/([\w-]+)$/))) html = viewTeam(m[1]);
  else if ((m = p.match(/^\/manager\/([\w-]+)$/))) html = viewManager(m[1], m[1] === me);
  else html = card('Nicht gefunden', '<div class="empty"><a href="#/">Zur Übersicht</a></div>');
  $('view').innerHTML = html;
  chrome();
  bind();
  if (routeKey !== p) { routeKey = p; window.scrollTo(0, 0); }
  if (typing && $(typing)) { const el = $(typing); el.focus(); try { el.setSelectionRange(caret, caret); } catch (e) {} }
  tickElapsed();
}

function bind() {
  document.querySelectorAll('[data-href]').forEach(el => el.onclick = e => {
    if (e.target.closest('a,button')) return;
    location.hash = el.dataset.href;
  });
  document.querySelectorAll('a.plink').forEach(a => a.onclick = e => { e.preventDefault(); location.hash = '#/spieler/' + a.dataset.pid; });
  bindLogin();
  const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
  on('q', 'oninput', e => { ui.q = e.target.value; render(); });
  on('teamf', 'onchange', e => { ui.team = e.target.value; render(); });
  on('tAvail', 'onclick', () => { ui.avail = !ui.avail; render(); });
  on('tWatch', 'onclick', () => { ui.watch = !ui.watch; render(); });
  on('logout', 'onclick', () => { session = ''; me = ''; store.del('lf.session'); store.del('lf.me'); location.hash = '#/'; render(true); });
  on('notif', 'onclick', async () => { unlockAudio(); try { await Notification.requestPermission(); } catch (e) {} render(); });
  document.querySelectorAll('[data-role]').forEach(b => b.onclick = () => { ui.role = b.dataset.role; render(); });
  document.querySelectorAll('[data-prole]').forEach(b => b.onclick = () => { ui.prole = b.dataset.prole; render(); });
  document.querySelectorAll('[data-sort]').forEach(b => b.onclick = e => { e.preventDefault(); ui.sort = b.dataset.sort; render(); });
  document.querySelectorAll('[data-psort]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); ui.psort = b.dataset.psort; render(); });
  document.querySelectorAll('[data-star]').forEach(b => b.onclick = () => {
    const id = b.dataset.star;
    watch.has(id) ? watch.delete(id) : watch.add(id);
    store.set('lf.watch', [...watch]);
    render();
  });
  document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => doPick(b.dataset.pick));
}

// ── worker ────────────────────────────────────────────────────────────────
async function api(p, opt) {
  opt = opt || {};
  const headers = {};
  if (opt.body) headers['Content-Type'] = 'application/json';
  if (session) headers.Authorization = 'Bearer ' + session;
  let r;
  try { r = await fetch(WORKER + p, { method: opt.method || 'GET', headers, body: opt.body ? JSON.stringify(opt.body) : undefined }); }
  catch (e) { throw new Error('Draft-Server nicht erreichbar.'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && session) { session = ''; me = ''; store.del('lf.session'); store.del('lf.me'); }
    throw new Error(data.error || 'Fehler ' + r.status);
  }
  return data;
}

async function doPick(id) {
  if (ui.busy) return;
  ui.busy = true; render();
  try {
    await api('/api/pick', { method: 'POST', body: { player: id } });
    toast(`<b>${esc(U.playerName(D, id))}</b> gehört dir.`, id);
    await pollLive(true);
  } catch (e) {
    toast(`<span style="color:#ffb1b3">${esc(e.message)}</span>`);
    await pollLive(true);
  } finally { ui.busy = false; render(); }
}

let liveSig = '';
async function pollLive(force) {
  try {
    const s = await api('/api/state');
    const picks = (s.league.draft && s.league.draft.picks) || [];
    if (lastPickCount !== null && picks.length > lastPickCount) {
      for (const p of picks.slice(lastPickCount)) {
        if (p.manager !== me) toast(`<b>${esc((s.league.managers.find(m => m.id === p.manager) || {}).name || p.manager)}</b> pickt <b>${esc(U.playerName(D, p.player))}</b>`, p.player);
      }
    }
    lastPickCount = picks.length;
    const sig = JSON.stringify([picks.length, s.claimed, s.league.managers, s.league.draft.completed]);
    LIVE = s;
    if (sig !== liveSig || force) { liveSig = sig; SEASON = SEASON; render(); }
  } catch (e) { /* static data still renders; next poll retries */ }
}

function schedulePoll() {
  // fast while a draft is on and you are looking at it; slow otherwise;
  // nothing while the tab is hidden (spares the free-tier quotas)
  const open = !LIVE || draftOpen();
  const delay = !open ? 300000 : path() === '/draft' ? 4000 : 15000;
  setTimeout(async () => { if (!document.hidden) await pollLive(); schedulePoll(); }, delay);
}

// ── feedback: toasts, sound, notification, timer ──────────────────────────
function toast(html, pid) {
  const p = pid && D.P.get(pid);
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = (p && p.photo ? `<img class="ph" src="${esc(p.photo)}" alt="">` : '') + `<div>${html}</div>`;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 5000);
}
let actx = null;
function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) {} }
function yourTurn() {
  try {
    if (actx) {
      [0, .14].forEach((t, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.frequency.value = i ? 1046 : 784; o.type = 'sine';
        g.gain.setValueAtTime(.0001, actx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(.18, actx.currentTime + t + .02);
        g.gain.exponentialRampToValueAtTime(.0001, actx.currentTime + t + .35);
        o.connect(g).connect(actx.destination); o.start(actx.currentTime + t); o.stop(actx.currentTime + t + .4);
      });
    }
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('LEC Fantasy — du bist dran!', { body: 'Dein Pick im Draft.', icon: 'icon-192.png', tag: 'turn' });
    }
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  } catch (e) {}
}
function tickElapsed() {
  const el = $('elapsed');
  if (!el) return;
  const picks = L().draft.picks || [], last = picks[picks.length - 1];
  if (!last || !last.at) return;
  const s = Math.max(0, Math.floor((Date.now() - new Date(last.at).getTime()) / 1000));
  el.textContent = s >= 3600 ? Math.floor(s / 3600) + 'h ' + String(Math.floor(s / 60) % 60).padStart(2, '0') + 'm'
    : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ── boot ──────────────────────────────────────────────────────────────────
(async function boot() {
  try { D = await U.load(); }
  catch (e) { $('view').innerHTML = card('Fehler', '<div class="empty">Daten konnten nicht geladen werden.</div>'); return; }
  rebuild();
  render();
  window.addEventListener('hashchange', () => render());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollLive(); });
  setInterval(tickElapsed, 1000);
  // static data (stats/rosters) refresh — new Action commits show up without reload
  setInterval(async () => { try { D = await U.load(); rebuild(); render(); } catch (e) {} }, 120000);
  await pollLive(true);
  schedulePoll();
})();
})();
