// ═══════════════════════════════════════════════════════════════════════════
// Special events (First Stand, MSI, Worlds): page #/event/<slug>.
//
// Budget team (5 players, one per role, captain), event pick'em, event table,
// tournament (stages, Swiss records, bracket) and teams - in the look of the
// event. With a YouTube link set by the admin, the page opens with an intro:
// a tap ("Betreten") starts the official video WITH sound (browsers only allow
// sound after a tap), the logo plays in, then the page slides up in front of
// the running video. app.js is one closure, so it hands its helpers in:
// window.LECEventsInit(app) returns the functions app.js calls.
// ═══════════════════════════════════════════════════════════════════════════
window.LECEventsInit = function (app) {
'use strict';
const { L, S, U, esc, fmt, card, loggedIn, adminOnly, me, api, toast, render, store, path, scoring } = app;
const $ = id => document.getElementById(id);
const EVX = { data: {}, loading: {}, mine: {}, form: {}, tips: {}, mt: {}, openMatch: null, tab: 'tips', role: 'TOP', q: '', team: '', open: null, player: null, playerSlug: null, entered: {}, ytReady: null, bingoStage: null };
const EV_ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
// Colors per event (the font is the same on the whole site, theme.css).
// Worlds: Riot's League/Worlds Hextech palette - gold on deep blue, teal.
const EV_THEMES = {
  worlds:      { accent: '#c8aa6e', hi: '#f0e6d2', soft: 'rgba(200,170,110,.14)', teal: '#0ac8b9', bg: '#010a13', surface: '9,20,40', short: 'Worlds' },
  msi:         { accent: '#8c9bff', hi: '#e2e6ff', soft: 'rgba(140,155,255,.15)', teal: '#5ee6ff', bg: '#06070f', surface: '15,17,34', short: 'MSI' },
  first_stand: { accent: '#d4ff3a', hi: '#f4ffd0', soft: 'rgba(212,255,58,.12)', teal: '#d4ff3a', bg: '#070806', surface: '17,19,13', short: 'First Stand' },
};
const evIndex = () => ((app.D && app.D.eventsIndex && app.D.eventsIndex.events) || []);
const evInfo = slug => evIndex().find(e => e.slug === slug) || null;
const evTheme = slug => EV_THEMES[(evInfo(slug) || {}).league] || EV_THEMES.worlds;
const evShort = slug => { const i = evInfo(slug); return (EV_THEMES[i && i.league] || {}).short || (i ? i.name : slug); };

// events of this league that are on (from 30 days before the start to 14 days after the end)
function activeEvents() {
  const now = Date.now();
  return Object.values((L() && L().events) || {}).map(ev => ({ ev, info: evInfo(ev.slug) })).filter(x => x.info && (x.ev.replay ||
    Date.parse(x.info.start) - 30 * 864e5 <= now && Date.parse(x.info.end) + 15 * 864e5 >= now))
    .sort((a, b) => a.info.start.localeCompare(b.info.start));
}
function currentEventSlug() { const a = activeEvents(); return a.length ? a[0].ev.slug : null; }

function loadEventData(slug) {
  if (EVX.data[slug] || EVX.loading[slug]) return;
  EVX.loading[slug] = true;
  U.getJson('data/events/' + slug + '.json', true).then(d => { EVX.data[slug] = d || { teams: [], players: [], schedule: [], stages: [], games: [] }; })
    .finally(() => { EVX.loading[slug] = false; render(); });
}
async function loadMine(slug) {
  if (!loggedIn() || adminOnly()) { EVX.mine[slug] = {}; return; }
  try { EVX.mine[slug] = await api('/api/event?slug=' + encodeURIComponent(slug)); } catch (e) { EVX.mine[slug] = { err: e.message }; }
  const t = EVX.mine[slug].team;
  if (!EVX.form[slug]) EVX.form[slug] = t ? { players: Object.fromEntries(t.players.map(id => [evP(slug, id) ? evP(slug, id).role : '', id])), captain: t.captain } : { players: {}, captain: '' };
  EVX.mt[slug] = Object.assign({}, EVX.mine[slug].matchTips || {});
  if (!EVX.tips[slug]) { const r = EVX.mine[slug].rounds || {}; EVX.tips[slug] = { pre: Object.assign({}, (r.pre || {}).tips || EVX.mine[slug].tips || {}), ko: Object.assign({}, (r.ko || {}).tips || {}) }; }
  render();
}

// ── small helpers ─────────────────────────────────────────────────────────
// event data as of now - a test replay (ev.replay) recomputed at most every 5 s
const EVR = {};
// The schedule straight from lolesports while an event page is open: new
// Swiss pairings and results show up within a minute (the event file only
// refreshes every 2 hours). Merged by match id; replays keep their own clock.
const EVLIVE = {}, EVLID = {};
async function loadLive(slug) {
  const raw = EVX.data[slug];
  if (!raw || !raw.league || (EVLIVE[slug] && Date.now() - EVLIVE[slug].at < 55000)) return;
  EVLIVE[slug] = Object.assign({}, EVLIVE[slug], { at: Date.now() });
  const H = { headers: { 'x-api-key': '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z' } }, G = 'https://esports-api.lolesports.com/persisted/gw/';
  try {
    if (!EVLID[raw.league]) EVLID[raw.league] = ((await (await fetch(G + 'getLeagues?hl=en-US', H)).json()).data.leagues.find(l => l.slug === raw.league) || {}).id;
    const id = EVLID[raw.league];
    if (!id) return;
    const first = (await (await fetch(G + 'getSchedule?hl=en-US&leagueId=' + id, H)).json()).data.schedule;
    let evs = first.events.slice();
    for (const dir of ['newer', 'older']) {
      const tok = (first.pages || {})[dir];
      if (tok) { const sch = (await (await fetch(G + 'getSchedule?hl=en-US&leagueId=' + id + '&pageToken=' + encodeURIComponent(tok), H)).json()).data.schedule; evs = dir === 'newer' ? evs.concat(sch.events) : sch.events.concat(evs); }
    }
    const rows = evs.filter(e => e.type === 'match' && e.match).map(e => ({ match: e.match.id, start: e.startTime, state: e.state, bestOf: (e.match.strategy || {}).count || 1,
      teams: (e.match.teams || []).map(t => ({ code: t.code || 'TBD', wins: (t.result || {}).gameWins, outcome: (t.result || {}).outcome })) }));
    EVLIVE[slug] = { at: Date.now(), rows };
    render();
  } catch (e) { /* the event file is good enough */ }
}
setInterval(() => { const m = path().match(/^\/event\/([\w-]+)$/); if (m && !document.hidden) loadLive(m[1]); }, 60000);
function evD(slug) {
  const raw0 = EVX.data[slug], ev = ((L() && L().events) || {})[slug];
  const live = EVLIVE[slug] && EVLIVE[slug].rows;
  const raw = raw0 && live && !(ev && ev.replay) ? S.mergeLiveSchedule(raw0, live) : raw0;
  if (!raw || !ev || !ev.replay) return raw;
  const k = JSON.stringify(ev.replay) + '|' + Math.floor(Date.now() / 5000);
  if (!EVR[slug] || EVR[slug].k !== k) EVR[slug] = { k, d: S.eventReplay(raw, ev.replay) };
  return EVR[slug].d;
}
setInterval(() => { const m = path().match(/^\/event\/([\w-]+)$/); const ev = m && L() && (L().events || {})[m[1]]; if (ev && ev.replay && !document.hidden && !(document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName))) render(); }, 15000);
const evP = (slug, id) => S.eventPlayer(evD(slug), id);
const evT = (slug, code) => ((evD(slug) || {}).teams || []).find(t => t.code === code);
function evLogo(slug, code, size) {
  const t = evT(slug, code);
  size = size || 20;
  return t && t.logo ? `<img class="tlogo" src="${esc(t.logo)}" alt="${esc(code)}" title="${esc(t.name)}" width="${size}" height="${size}" loading="lazy">` : `<span class="tcode">${esc(code || '')}</span>`;
}
function evCell(slug, id, opts) {
  opts = opts || {};
  const p = evP(slug, id);
  if (!p) return `<span class="pname">${esc(id)}</span>`;
  const photo = opts.photo ? (p.photo ? `<img class="ph" src="${esc(p.photo)}" alt="" loading="lazy">` : '<span class="ph ph-none"></span>') : '';
  return `<span class="pcell">${photo}${evLogo(slug, p.team)} <span class="role">${esc(p.role)}</span> <span class="pname">${esc(p.name)}</span></span>`;
}
function evPoints(slug) {
  const d = evD(slug), out = new Map();
  for (const g of (d && d.games) || []) out.set(g.player, (out.get(g.player) || 0) + S.gamePoints(g, scoring()));
  return out;
}
const fmtLeft = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return s >= 86400 ? `${Math.floor(s / 86400)} T ${Math.floor(s % 86400 / 3600)} Std` : s >= 3600 ? `${Math.floor(s / 3600)} Std ${Math.floor(s / 60) % 60} Min` : `${Math.floor(s / 60)} Min`; };
function stageLine(slug) {
  const d = evD(slug), st = S.eventStages(d), now = Date.now();
  if (!st.length) return 'Spielplan kommt noch';
  const open = S.eventOpenStage(d, now);
  if (S.eventDone(d)) return 'vorbei';
  const cur = st.filter(x => x.lock !== null && x.lock <= now).pop();
  const nxt = open === null ? null : st[open];
  return (cur ? `<b>${esc(cur.name)}</b> läuft` : 'startet bald') + (nxt && nxt.lock ? ` · ${cur ? 'nächste Phase' : esc(nxt.name)} in <b>${fmtLeft(nxt.lock - now)}</b>` : '');
}

// ── theme + video ─────────────────────────────────────────────────────────
function applyEventTheme(slug) {
  let st = document.getElementById('evtheme');
  if (!slug) { if (st) st.remove(); document.body.classList.remove('ev-on'); return; }
  const t = evTheme(slug);
  if (!st) { st = document.createElement('style'); st.id = 'evtheme'; document.head.appendChild(st); }
  st.textContent = `body.ev-on{--gold:${t.accent};--gold-hi:${t.hi};--gold-soft:${t.soft};--teal:${t.teal};--teal-hi:${t.hi};--bg:${t.bg};--surface:rgb(${t.surface});--surface-2:rgba(${t.surface},.9);background:${t.bg}}
    body.ev-on.ev-video{background:#000}
    body.ev-on.ev-video .card{background:rgba(${t.surface},.66);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-color:rgba(255,255,255,.09)}
    body.ev-on.ev-video .topbar,body.ev-on.ev-video .tabbar{background:rgba(0,0,0,.55);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
    body.ev-on.ev-video .footer{background:transparent}`;
  document.body.classList.add('ev-on');
}
function ytApi() {
  if (EVX.ytReady) return EVX.ytReady;
  EVX.ytReady = new Promise(res => {
    if (window.YT && window.YT.Player) return res(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(window.YT); };
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
  });
  return EVX.ytReady;
}
// Video preference is PER EVENT: switching Worlds off must not silence MSI.
// (It used to be one global 'lf.evVideo' key - skipping one intro killed the
// video everywhere.) Old global value is honoured once as a migration.
const videoOff = slug => {
  const v = store.get('lf.evVideo.' + slug, null);
  if (v !== null && v !== undefined) return v === 'off';
  return store.get('lf.evVideo', 'on') === 'off';          // legacy fallback
};
const setVideoOff = (slug, off) => store.set('lf.evVideo.' + slug, off ? 'off' : 'on');
// The intro is a ONE-TIME welcome per event, remembered across visits and
// reloads - not a gate you have to click through every time you come back.
const introSeen = slug => store.get('lf.evSeen.' + slug, '') === '1';
const markIntroSeen = slug => store.set('lf.evSeen.' + slug, '1');
// Every visit to the event page: intro with "Betreten"; that tap starts the
// video WITH sound behind the page. The player is created unmuted and paused
// beforehand so the tap only has to press play. If a browser still refuses
// sound (iPhone Safari may), the video runs muted and the 🔇 button in the
// control bar turns it on. "Video aus" sticks per device until switched on.
const evVol = () => Math.max(0, Math.min(100, Number(store.get('lf.evVol', 70)) || 0));
async function prepareVideo(slug) {
  const ev = (L().events || {})[slug];
  if (!ev || !ev.video || videoOff(slug) || EVX.playerSlug === slug) return;
  stopVideo();
  EVX.playerSlug = slug; EVX.saw = false; EVX.wantPlay = false;
  let bg = document.getElementById('evbg');
  if (!bg) { bg = document.createElement('div'); bg.id = 'evbg'; bg.className = 'evbg'; bg.innerHTML = '<div id="evbgPlayer"></div>'; document.body.prepend(bg); }
  const YT = await ytApi();
  if (EVX.playerSlug !== slug) return;
  EVX.player = new YT.Player('evbgPlayer', { videoId: ev.video,
    playerVars: { origin: location.origin, enablejsapi: 1, autoplay: 0, controls: 0, playsinline: 1, rel: 0, modestbranding: 1, disablekb: 1, iv_load_policy: 3, fs: 0, start: ev.videoStart || 0 },
    events: {
      onReady: () => { EVX.ready = true; try { EVX.player.setVolume(evVol()); } catch (e) { /* ignore */ } if (EVX.wantPlay) playNow(); },
      onError: () => { toast('Das Video lässt sich nicht abspielen — Link im Admin prüfen.'); stopVideo(); },
      onStateChange: e => {
        if (e.data === 1 || e.data === 3) EVX.saw = true;
        if (e.data === 0 && EVX.player === e.target) { e.target.seekTo(ev.videoStart || 0, true); e.target.playVideo(); }   // loop
        drawControls();
      } } });
}
// inside the tap
function playNow() {
  const p = EVX.player;
  if (!p || !p.playVideo || !EVX.ready) { EVX.wantPlay = true; return; }
  EVX.wantPlay = false;
  try { p.unMute(); p.setVolume(evVol()); p.playVideo(); } catch (e) { /* ignore */ }
  document.body.classList.add('ev-video');
  const b = document.getElementById('evbg'); if (b) b.classList.add('on');
  drawControls();
  // nothing started (no buffering, no ad): this browser blocks sound -> play muted
  setTimeout(() => {
    if (EVX.player !== p || EVX.saw) return;
    try { p.mute(); p.playVideo(); } catch (e) { /* ignore */ }
    EVX.blocked = true; drawControls();
  }, 2500);
}
function stopVideo() {
  try { if (EVX.player && EVX.player.destroy) EVX.player.destroy(); } catch (e) { /* gone */ }
  EVX.player = null; EVX.playerSlug = null; EVX.ready = false; EVX.blocked = false;
  const b = document.getElementById('evbg'); if (b) b.remove();
  const c = document.getElementById('evctl'); if (c) c.remove();
  document.body.classList.remove('ev-video');
}
// Leaving the video tab must not destroy the player - destroying it loses the
// playback position AND the browser's "user already allowed sound" state, so
// coming back would need another tap. Pause and hide instead; resume picks up
// where it left off.
function pauseVideo() {
  const p = EVX.player;
  if (!p) return;
  try { if (p.pauseVideo) p.pauseVideo(); } catch (e) { /* ignore */ }
  document.body.classList.remove('ev-video');
  const b = document.getElementById('evbg'); if (b) b.classList.remove('on');
  const c = document.getElementById('evctl'); if (c) c.remove();
}
function resumeVideo() {
  const p = EVX.player;
  if (!p || !EVX.ready) { EVX.wantPlay = true; return; }
  try { p.playVideo(); } catch (e) { /* ignore */ }
  document.body.classList.add('ev-video');
  const b = document.getElementById('evbg'); if (b) b.classList.add('on');
  drawControls();
}
// floating bar: mute, volume, video off
function drawControls() {
  const p = EVX.player;
  let c = document.getElementById('evctl');
  if (!p || !document.body.classList.contains('ev-video')) { if (c) c.remove(); return; }
  let muted = false;
  try { muted = p.isMuted(); } catch (e) { /* not ready */ }
  if (!c) {
    c = document.createElement('div'); c.id = 'evctl'; c.className = 'evctl';
    c.innerHTML = `<button class="evctl-b" id="evMute" title="Ton an/aus"></button>
      <input type="range" id="evVolR" min="0" max="100" step="1" aria-label="Lautstärke">
      <button class="evctl-b" id="evOff" title="Video aus">✕ Video</button>`;
    document.body.appendChild(c);
    c.querySelector('#evMute').onclick = () => {
      const pl = EVX.player; if (!pl) return;
      try { if (pl.isMuted()) { pl.unMute(); pl.setVolume(evVol() || 50); if (!evVol()) store.set('lf.evVol', 50); pl.playVideo(); EVX.blocked = false; } else pl.mute(); } catch (e) { /* ignore */ }
      setTimeout(drawControls, 120);
    };
    const r = c.querySelector('#evVolR');
    r.oninput = () => {
      const v = +r.value; store.set('lf.evVol', v);
      const pl = EVX.player; if (!pl) return;
      try { pl.setVolume(v); if (v > 0 && pl.isMuted()) pl.unMute(); if (v === 0) pl.mute(); } catch (e) { /* ignore */ }
      r.style.setProperty('--v', v + '%');
      c.querySelector('#evMute').textContent = v === 0 ? '🔇' : '🔊';
    };
    c.querySelector('#evOff').onclick = () => { if (EVX.playerSlug) setVideoOff(EVX.playerSlug, true); stopVideo(); render(); };
  }
  const r = c.querySelector('#evVolR');
  if (document.activeElement !== r) { r.value = muted ? 0 : evVol(); r.style.setProperty('--v', r.value + '%'); }
  c.querySelector('#evMute').textContent = muted || EVX.blocked ? '🔇' : '🔊';
  c.classList.toggle('hint', !!(muted && EVX.blocked));
}
function enterEvent(slug) {
  EVX.entered[slug] = true;
  markIntroSeen(slug);                               // never gate this event again
  setVideoOff(slug, false);
  playNow();                                         // inside the tap: sound allowed
  const o = document.getElementById('evintro');
  if (o) { o.classList.add('play'); setTimeout(() => { o.classList.add('out'); const v = $('view'); if (v) { v.classList.remove('ev-rise'); void v.offsetWidth; v.classList.add('ev-rise'); } }, 2600); setTimeout(() => { o.remove(); render(); }, 3500); }
}
function introOverlay(slug) {
  if (document.getElementById('evintro')) return;
  const info = evInfo(slug) || {}, ev = L().events[slug];
  const o = document.createElement('div');
  o.id = 'evintro'; o.className = 'evintro';
  o.innerHTML = `<div class="evintro-in">${info.logo ? `<img class="evintro-logo" src="${esc(info.logo)}" alt="">` : ''}
    <div class="evintro-name">${esc(ev.name || info.name || slug)}</div>
    <div class="evintro-sub">${esc(info.start ? new Date(info.start).toLocaleDateString('de-DE', { day: '2-digit', month: 'long' }) + ' – ' + new Date(info.end).toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' }) : '')}</div>
    <button class="btn gold lg evintro-go" id="evGo">Betreten 🔊</button>
    <a href="#" class="evintro-skip" id="evSkip">ohne Video &amp; Musik</a></div>`;
  document.body.appendChild(o);
  o.querySelector('#evGo').onclick = () => enterEvent(slug);
  o.querySelector('#evSkip').onclick = e => { e.preventDefault(); setVideoOff(slug, true); stopVideo(); EVX.entered[slug] = true; markIntroSeen(slug); o.remove(); render(); };
}
// called by app.js render() on every route
// Rules:
//   * the video belongs to the event page - leaving it tears the player down
//   * the intro overlay is a ONE-TIME welcome per event (persisted), not a gate
//   * inside the event, the video plays on VIDEO_TAB only; other tabs pause it
//     (pause, not destroy - so coming back resumes with sound still allowed)
const VIDEO_TAB = 'team';
function eventRouteHook(p) {
  const m = p.match(/^\/event\/([\w-]+)$/);
  const slug = m && loggedIn() && (L().events || {})[m[1]] ? m[1] : null;
  applyEventTheme(slug);
  if (!slug) { stopVideo(); EVX.entered = {}; const o = document.getElementById('evintro'); if (o) o.remove(); return; }
  const ev = L().events[slug];
  if (!ev.video || videoOff(slug)) { stopVideo(); return; }

  prepareVideo(slug);
  // first ever visit to this event: show the intro once
  if (!EVX.entered[slug] && !introSeen(slug)) { introOverlay(slug); return; }
  EVX.entered[slug] = true;
  // already introduced: follow the tab, honouring the saved on/off toggle
  if (EVX.tab === VIDEO_TAB) resumeVideo(); else pauseVideo();
}

// ── page ──────────────────────────────────────────────────────────────────
function viewEvent(slug) {
  const ev = (L().events || {})[slug];
  if (!ev) return card('Event', '<div class="empty">Dieses Event ist nicht angelegt. <a href="#/">Zur Übersicht</a></div>');
  const d = evD(slug);
  if (!d) { loadEventData(slug); return card(esc(ev.name), '<div class="empty">lädt …</div>'); }
  if (!ev.replay) loadLive(slug);
  if (EVX.mine[slug] === undefined) { EVX.mine[slug] = null; loadMine(slug); }
  const info = evInfo(slug) || {};
  // no squad unless the event switches it on (ev.squad)
  const squadOn = S.eventSquadOn(ev);
  if (!squadOn && EVX.tab === 'team') EVX.tab = 'tips';
  if (!S.eventTipsOn(ev) && EVX.tab === 'tips') EVX.tab = 'pickem';
  const tabs = [...(squadOn ? [['team', adminOnly() ? 'Teams' : 'Mein Team']] : []), ...(S.eventTipsOn(ev) ? [['tips', 'Tippspiel']] : []), ['live', ((d.schedule || []).some(e => e.state === 'inProgress') ? '<span class="live-dot"></span> ' : '') + 'Live'], ['pickem', 'Pick\'em'], ...(S.eventMinigame(ev) === 'bingo' ? [['bingo', 'Bingo']] : S.eventMinigame(ev) === 'monopoly' ? [['mono', 'Monopoly']] : []), ['table', 'Tabelle'], ['tour', 'Turnier'], ['teams', 'Teilnehmer']];
  const hero = `<section class="hero evhero">
      <div class="row" style="gap:18px;align-items:center;flex-wrap:wrap">${info.logo ? `<img src="${esc(info.logo)}" alt="" style="height:64px;max-width:160px;object-fit:contain">` : ''}
      <div style="min-width:0;flex:1"><div class="eyebrow">Special Event · ${esc(info.start ? new Date(info.start).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' – ' + new Date(info.end).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '')}</div>
      <h1 style="margin:2px 0 4px;overflow-wrap:anywhere">${esc(ev.name)}</h1><div class="sub">${stageLine(slug)}</div>
      ${ev.video && videoOff(slug) ? `<button class="btn sm" id="evVid" style="margin-top:10px">▶ Video &amp; Musik an</button>` : ''}</div></div></section>`;
  const chips = `<div class="chips" style="margin:0 0 16px">${tabs.map(([k, l]) => `<button class="chip ${EVX.tab === k ? 'on' : ''}" data-evtab="${k}">${l}</button>`).join('')}</div>`;
  let body = '';
  if (!d.teams.length && (EVX.tab === 'team' || EVX.tab === 'teams' || EVX.tab === 'tips')) body = card(esc(ev.name), '<div class="empty">Die Teilnehmer stehen noch nicht fest. Sobald Riot sie einträgt (meist ein paar Tage vorher), kannst du hier dein Team bauen.</div>');
  else if (EVX.tab === 'team') body = adminOnly() ? evAllTeams(slug) : evBuilder(slug);
  else if (EVX.tab === 'tips') body = evTips(slug);
  else if (EVX.tab === 'live') body = evLive(slug);
  else if (EVX.tab === 'pickem') body = evPickem(slug);
  else if (EVX.tab === 'bingo') body = evBingo(slug);
  else if (EVX.tab === 'mono') body = evMono(slug);
  else if (EVX.tab === 'table') body = evTable(slug);
  else if (EVX.tab === 'tour') body = evTour(slug);
  else body = evTeams(slug);
  const replay = ev.replay ? `<div class="note" style="border-color:var(--gold)">🧪 <b>Wiederholung (Test)</b> — das echte ${esc(info.name || '')} spielt sich im Zeitraffer noch einmal ab. Punkte kommen Spiel für Spiel.${adminOnly() ? `<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:8px"><button class="btn sm gold" data-evjump="phase">⏭ Phase fertig</button><button class="btn sm" data-evjump="end">⏭⏭ Event fertig</button><button class="btn sm" data-evjump="restart">↺ Neustart</button></div>` : ''}</div>` : '';
  return hero + replay + chips + body;
}

// team builder
function evBuilder(slug) {
  const ev = L().events[slug], d = evD(slug), c = S.eventConfig(ev), mine = EVX.mine[slug];
  if (mine === null) return card('Mein Team', '<div class="empty">lädt …</div>');
  const stage = mine.stage;
  if (stage === null || stage === undefined) return evMyHistory(slug) || card('Mein Team', '<div class="empty">Das Event ist vorbei.</div>');
  const f = EVX.form[slug] || (EVX.form[slug] = { players: {}, captain: '' });
  const ids = EV_ROLES.map(r => f.players[r]).filter(Boolean);
  const cost = ids.reduce((t, id) => t + S.eventPrice(ev, d, id), 0);
  const left = c.budget - cost;
  const sel = { players: ids, captain: f.captain };
  const why = ids.length === 5 ? S.eventTeamError(ev, d, sel) : `Noch ${5 - ids.length} Rolle${5 - ids.length === 1 ? '' : 'n'} frei.`;
  const saved = mine.team && JSON.stringify([...mine.team.players].sort()) === JSON.stringify([...ids].sort()) && mine.team.captain === f.captain;
  const st = S.eventStages(d)[stage];
  const pts = evPoints(slug);
  const slot = r => {
    const id = f.players[r];
    if (!id) return `<div class="evslot empty ${EVX.role === r ? 'on' : ''}" data-evrole="${r}"><span class="role">${r}</span><span class="dim">Spieler wählen</span></div>`;
    const p = evP(slug, id);
    return `<div class="evslot ${EVX.role === r ? 'on' : ''}" data-evrole="${r}">${p && p.photo ? `<img class="ph" src="${esc(p.photo)}" alt="">` : '<span class="ph ph-none"></span>'}
      <div style="flex:1;min-width:0"><div class="row" style="gap:6px;min-width:0">${evLogo(slug, p.team, 18)}<b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</b></div><div class="dim" style="font-size:12px">${r} · ${S.eventPrice(ev, d, id)} Credits</div></div>
      <button class="btn sm ${f.captain === id ? 'gold' : ''}" data-evcap="${esc(id)}" title="Kapitän: Punkte ×${fmt(c.captain)}">★</button><button class="btn sm" data-evdrop="${r}">✕</button></div>`;
  };
  const head = `<div class="card-b"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><div><b style="font-size:18px">${cost}</b> <span class="dim">/ ${c.budget} Credits</span> · <span style="color:${left < 0 ? 'var(--loss)' : 'var(--win)'}">${left >= 0 ? 'noch ' + left : left + ' drüber'}</span></div>
      <div class="dim" style="font-size:12px">für <b style="color:var(--text)">${esc(st.name)}</b>${st.lock ? ' · sperrt in ' + fmtLeft(st.lock - Date.now()) : ''}</div></div>
      <div class="evbar"><div style="width:${Math.min(100, cost / c.budget * 100)}%;${left < 0 ? 'background:var(--loss)' : ''}"></div></div></div>`;
  const slots = `<div class="evslots">${EV_ROLES.map(slot).join('')}</div>`;
  const foot = `<div class="card-b row" style="flex-wrap:wrap;gap:10px;border-top:1px solid var(--line)"><button class="btn gold" id="evSave" ${why ? 'disabled' : ''}>${saved ? 'Gespeichert ✓' : 'Team speichern'}</button>
      <span class="muted" style="font-size:12px">${why ? esc(why) : saved ? 'Bis zur Sperre änderbar. Niemand sieht dein Team vorher.' : 'Noch nicht gespeichert.'} Max. ${c.maxPerTeam} pro Team · Kapitän ×${fmt(c.captain)} · ohne neues Team gilt deins aus der letzten Phase weiter.</span></div>`;
  // market
  const q = EVX.q.toLowerCase();
  const cur = f.players[EVX.role];
  const curCost = cur ? S.eventPrice(ev, d, cur) : 0;
  const perTeam = {}; for (const id of ids) { const p = evP(slug, id); if (p && id !== cur) perTeam[p.team] = (perTeam[p.team] || 0) + 1; }
  const list = d.players.filter(p => p.role === EVX.role && (!EVX.team || p.team === EVX.team) && (!q || [p.name, p.realName, p.team].join(' ').toLowerCase().includes(q)))
    .map(p => ({ p, price: S.eventPrice(ev, d, p.id), pts: pts.get(p.id) || 0 }))
    .sort((a, b) => b.price - a.price || b.pts - a.pts || a.p.name.localeCompare(b.p.name));
  const rows = list.map(x => {
    const mineNow = cur === x.p.id;
    const tooMuch = cost - curCost + x.price > c.budget, teamFull = (perTeam[x.p.team] || 0) >= c.maxPerTeam;
    return `<tr><td class="fill">${evCell(slug, x.p.id, { photo: true })}</td><td class="num"><span class="pill">${x.price}</span></td>${pts.size ? `<td class="num pts hide-s">${fmt(x.pts)}</td>` : ''}
      <td class="num" style="width:1%">${mineNow ? '<span class="pill gold">drin</span>' : `<button class="btn sm gold" data-evpick="${esc(x.p.id)}" ${tooMuch || teamFull ? 'disabled' : ''} title="${tooMuch ? 'zu teuer' : teamFull ? `schon ${c.maxPerTeam} von ${x.p.team}` : ''}">Nehmen</button>`}</td></tr>`;
  }).join('');
  const market = card(`Spieler · ${EVX.role}`, `<div class="card-b row" style="gap:8px;flex-wrap:wrap"><span class="chips">${EV_ROLES.map(r => `<button class="chip ${EVX.role === r ? 'on' : ''}" data-evrole="${r}">${r}</button>`).join('')}</span>
      <input id="evQ" placeholder="Suchen …" value="${esc(EVX.q)}" style="flex:1;min-width:120px"><select id="evTeamF"><option value="">Alle Teams</option>${d.teams.map(t => `<option value="${esc(t.code)}" ${EVX.team === t.code ? 'selected' : ''}>${esc(t.code)}</option>`).join('')}</select></div>
      <table class="pool"><tbody>${rows || '<tr><td class="empty">kein Spieler</td></tr>'}</tbody></table>`, 'Preis' + (pts.size ? ' · Event-Punkte' : ''));
  return `<div class="grid g-main"><div class="stack">${card('Mein Team', head + slots + foot)}${evMyHistory(slug)}</div><div class="stack">${market}</div></div>`;
}
// my revealed lineups per stage
function evMyHistory(slug) {
  const ev = L().events[slug], d = evD(slug);
  const row = (S.eventStandings(L(), ev, d).find(r => r.manager === me())) || null;
  const st = S.eventStages(d).filter(s => (ev.revealed || []).includes(s.i));
  if (!st.length) return '';
  return card('Bisher', st.map(s => {
    const lu = S.eventLineup(ev, me(), s.i);
    return `<div class="card-b" style="border-bottom:1px solid var(--line)"><div class="row" style="justify-content:space-between"><b>${esc(s.name)}</b><span class="pts">${fmt((row && row.byStage[s.i]) || 0)}</span></div>
      <div class="dim" style="font-size:12px;margin-top:4px">${lu ? lu.players.map(id => esc((evP(slug, id) || {}).name || id) + (id === lu.captain ? ' ★' : '')).join(' · ') : 'kein Team'}</div></div>`;
  }).join(''));
}
// admin / after the lock: everybody's revealed teams
function evAllTeams(slug) {
  const ev = L().events[slug], d = evD(slug);
  const st = S.eventStages(d).filter(s => (ev.revealed || []).includes(s.i));
  if (!st.length) return card('Teams', '<div class="empty">Die Teams werden beim ersten Spiel aufgedeckt. Als Admin baust du kein Team — du siehst sie dann hier.</div>');
  return st.map(s => card(esc(s.name), (L().managers || []).map(m => {
    const lu = S.eventLineup(ev, m.id, s.i);
    return `<div class="card-b" style="border-bottom:1px solid var(--line)"><b>${esc(m.name)}</b><div class="dim" style="font-size:12px;margin-top:3px">${lu ? lu.players.map(id => esc((evP(slug, id) || {}).name || id) + (id === lu.captain ? ' ★' : '')).join(' · ') : 'kein Team'}</div></div>`;
  }).join(''))).join('');
}

// event pick'em
const PK_ROUNDS = [['pre', 'pickem', 'Vor dem Event'], ['ko', 'pickemKo', 'Vor der K.-o.-Phase']];
function evPickInput(slug, round, q, val) {
  const d = evD(slug), def = S.EVENT_TYPES[q.type] || {}, kind = def.kind;
  const attr = `data-evq="${esc(q.id)}" data-evr="${round}"`;
  // Only the teams that can actually appear in the answer - a Play-Ins
  // question must not offer teams that start in the Swiss stage.
  const pickTeams = S.eventQuestionTeams(d, q.type);
  if (def.count) {
    // several teams: tap the logos (at most `count`)
    const on = new Set(String(val || '').split(',').filter(Boolean));
    return `<div class="evmulti" ${attr} data-max="${def.count}">${pickTeams.map(t => `<button type="button" class="evchip ${on.has(t.code) ? 'on' : ''}" data-code="${esc(t.code)}" title="${esc(t.name)}">${evLogo(slug, t.code, 22)}<span>${esc(t.code)}</span></button>`).join('')}</div>
      <div class="dim" style="font-size:12px;margin-top:6px"><b class="evcount">${on.size}</b> / ${def.count} gewählt${pickTeams.length < (d.teams || []).length ? ` · nur die ${pickTeams.length} Teams dieser Phase` : ''}</div>`;
  }
  if (kind === 'number') return `<input type="number" step="0.1" ${attr} value="${esc(val || '')}" style="width:120px">`;
  let opts = [];
  if (kind === 'team') opts = pickTeams.map(t => [t.code, `${t.name} (${t.league || '?'})`]);
  if (kind === 'region') opts = [...new Set(d.teams.map(t => t.league).filter(Boolean))].map(r => [r, r]);
  if (kind === 'player') opts = d.players.slice().sort((a, b) => a.team.localeCompare(b.team) || EV_ROLES.indexOf(a.role) - EV_ROLES.indexOf(b.role)).map(p => [p.id, `${p.name} (${p.team} ${p.role})`]);
  if (kind === 'champion') opts = Object.entries(app.D.champs.names || {}).sort((a, b) => a[1].localeCompare(b[1]));
  if (kind === 'score') opts = S.eventFinalScores(d).map(x => [x, x]);
  if (kind === 'stage') opts = S.eventLevels(d).map(x => [x, x]);
  return `<select ${attr} style="max-width:100%"><option value="">— wählen —</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
function evPickLabel(slug, q, v) {
  if (v === undefined || v === null || v === '') return '<span class="dim">—</span>';
  const def = S.EVENT_TYPES[q.type] || {}, kind = def.kind;
  if (def.count) return String(v).split(',').filter(Boolean).map(c => `<span style="white-space:nowrap">${evLogo(slug, c, 16)} ${esc(c)}</span>`).join(' ');
  if (kind === 'team') return evLogo(slug, v, 18) + ' ' + esc(v);
  if (kind === 'player') return esc((evP(slug, v) || {}).name || v);
  if (kind === 'champion') return U.champIcon(app.D, v, 20) + ' ' + esc((app.D.champs.names || {})[v] || v);
  return esc(v);
}
function evPickem(slug) {
  const ev = L().events[slug], d = evD(slug), mine = EVX.mine[slug] || {};
  const rounds = PK_ROUNDS.filter(([, key]) => ev[key] && (ev[key].questions || []).length);
  if (!rounds.length) return card('Pick\'em', '<div class="empty">' + (adminOnly() ? 'Noch kein Pick\'em — leg ihn unter Admin → Events an.' : 'Noch kein Pick\'em — der Admin öffnet ihn vor dem Event.') + '</div>');
  const truth = S.eventTruth(d, scoring()), done = S.eventDone(d);
  const rows = S.eventStandings(L(), ev, d), mgrs = L().managers || [];
  return rounds.map(([round, key, title]) => {
    const pe = ev[key], st = (mine.rounds || {})[round] || {};
    const max = pe.questions.reduce((t, q) => t + (Number(q.points) || 0) * ((S.EVENT_TYPES[q.type] || {}).count || 1), 0);
    const locked = pe.revealed || !!st.locked;
    if (!locked && !adminOnly()) {
      const tips = (EVX.tips[slug] = EVX.tips[slug] || {})[round] || (EVX.tips[slug][round] = {});
      return card(`Pick'em · ${title}`, pe.questions.map(q => {
        const def = S.EVENT_TYPES[q.type] || {};
        return `<div class="card-b" style="border-bottom:1px solid var(--line)"><div style="margin-bottom:8px"><b>${esc(q.label || def.label)}</b> <span class="pill">${q.points} Pkt${def.count ? ' pro Treffer' : ''}</span></div>${evPickInput(slug, round, q, tips[q.id])}</div>`;
      }).join('') + `<div class="card-b row" style="flex-wrap:wrap;gap:10px"><button class="btn gold" data-evtipsave="${round}">Tipps speichern</button><span class="muted" style="font-size:12px">${st.lockAt ? 'Sperre in ' + fmtLeft(Date.parse(st.lockAt) - Date.now()) + ' · ' : ''}Niemand sieht deine Tipps vorher.</span></div>`, `max. ${max} Punkte`);
    }
    if (!pe.revealed) {
      return card(`Pick'em · ${title}`, adminOnly() ? pe.questions.map(q => `<div class="card-b" style="border-bottom:1px solid var(--line)"><b>${esc(q.label || S.EVENT_TYPES[q.type].label)}</b> <span class="pill">${q.points} Pkt</span></div>`).join('') + `<div class="card-b muted" style="font-size:12px">Die Tipps werden ${st.lockAt ? 'in ' + fmtLeft(Date.parse(st.lockAt) - Date.now()) : 'bei der Sperre'} aufgedeckt.</div>`
        : '<div class="empty">Gesperrt — die Tipps werden in der nächsten Minute aufgedeckt.</div>', `max. ${max} Punkte`);
    }
    const pre = round === 'ko' ? 'ko:' : '';
    const tv = q => { const def = S.EVENT_TYPES[q.type] || {}; if (def.manual) return q.answer ? [q.answer] : []; const t = truth[q.type]; return t instanceof Set ? [...t] : typeof t === 'number' ? [t] : []; };
    return card(`Pick'em · ${title}`, `<div style="overflow-x:auto"><table class="tight"><thead><tr><th>Frage</th><th>${done ? 'Ergebnis' : 'Stand'}</th>${mgrs.map(m => `<th>${esc(m.name)}</th>`).join('')}</tr></thead><tbody>`
      + pe.questions.map(q => `<tr><td style="white-space:normal;min-width:150px"><b>${esc(q.label || S.EVENT_TYPES[q.type].label)}</b> <span class="pill">${q.points}</span></td>
        <td style="white-space:normal;min-width:110px">${tv(q).length ? (S.EVENT_TYPES[q.type].count ? evPickLabel(slug, q, tv(q).join(',')) : tv(q).slice(0, 3).map(v => evPickLabel(slug, q, v)).join(', ')) : '<span class="dim">offen</span>'}</td>
        ${mgrs.map(m => { const v = ((pe.picks || {})[m.id] || {})[q.id], r = rows.find(x => x.manager === m.id) || {}, ok = (r.correct || []).includes(pre + q.id), h = (r.hits || {})[pre + q.id];
          return `<td style="white-space:normal;min-width:110px;${m.id === me() ? 'background:var(--gold-soft)' : ''}">${evPickLabel(slug, q, v)}${ok ? ` <span class="wl w">✓${h ? h : ''}</span>` : ''}</td>`; }).join('')}</tr>`).join('')
      + '</tbody></table></div>', `max. ${max} Punkte`);
  }).join('') + (done ? card('Pick\'em-Punkte', `<table><tbody>${rows.slice().sort((a, b) => b.pickem - a.pickem).map((r, i) => `<tr><td class="rank">${i + 1}</td><td class="fill"><b>${esc(r.name)}</b></td><td class="num pts">${fmt(r.pickem)}</td></tr>`).join('')}</tbody></table>`) : '');
}

// event table
function evTable(slug) {
  const ev = L().events[slug], d = evD(slug);
  const st = S.eventStages(d), rows = S.eventStandings(L(), ev, d);
  if (!S.eventSquadOn(ev)) {
    const bingo = S.eventMinigame(ev) === 'bingo';
    const tipsOn = S.eventTipsOn(ev);
    return card('Event-Tabelle', `<table><thead><tr><th>#</th><th>Manager</th>${tipsOn ? '<th class="num">Tipps</th>' : ''}<th class="num">Pick'em</th>${bingo ? '<th class="num hide-s">Bingo</th>' : ''}<th class="num">Punkte</th></tr></thead><tbody>`
      + rows.map((r, i) => `<tr class="${r.manager === me() ? 'me' : ''}"><td class="rank r${i + 1}">${i + 1}</td><td class="fill"><b>${esc(r.name)}</b>${r.manager === me() ? ' <span class="pill gold">Du</span>' : ''}
          ${tipsOn ? `<div class="dim" style="font-size:11px">${(r.tipStats || {}).right || 0} richtig · ${(r.tipStats || {}).exact || 0} exakt</div>` : ''}</td>
        ${tipsOn ? `<td class="num">${r.tips || 0}</td>` : ''}<td class="num">${fmt(r.pickem)}</td>${bingo ? `<td class="num hide-s">${fmt(r.bingo)}</td>` : ''}<td class="num pts" style="font-size:16px">${fmt(r.total)}</td></tr>`).join('')
      + '</tbody></table>', tipsOn ? 'Tipps live · Pick\'em nach dem Event' : 'Pick\'em zählt nach dem Event');
  }
  if (!(ev.revealed || []).length) return card('Tabelle', '<div class="empty">Die Teams werden beim ersten Spiel aufgedeckt — ab dann zählen die Punkte.</div>');
  const table = `<table><thead><tr><th>#</th><th>Manager</th>${st.map(s => `<th class="num hide-s">${esc(s.name)}</th>`).join('')}<th class="num hide-s">Pick'em</th><th class="num">Punkte</th></tr></thead><tbody>`
    + rows.map((r, i) => `<tr class="click ${r.manager === me() ? 'me' : ''}" data-evopen="${esc(r.manager)}"><td class="rank r${i + 1}">${i + 1}</td><td class="fill"><b>${esc(r.name)}</b>${r.manager === me() ? ' <span class="pill gold">Du</span>' : ''}</td>
      ${st.map(s => `<td class="num hide-s">${fmt(r.byStage[s.i] || 0)}</td>`).join('')}<td class="num hide-s">${fmt(r.pickem)}</td><td class="num pts" style="font-size:16px">${fmt(r.total)}</td></tr>`
      + (EVX.open === r.manager ? `<tr><td></td><td colspan="${st.length + 3}" style="white-space:normal">${st.filter(s => (ev.revealed || []).includes(s.i)).map(s => { const lu = S.eventLineup(ev, r.manager, s.i);
          return `<div style="margin:4px 0"><span class="dim">${esc(s.name)}:</span> ${lu ? lu.players.map(id => esc((evP(slug, id) || {}).name || id) + (id === lu.captain ? ' ★' : '') + ` <span class="dim">${fmt(r.perPlayer[id] || 0)}</span>`).join(' · ') : '—'}</div>`; }).join('')}</td></tr>` : '')).join('')
    + '</tbody></table>';
  return card('Event-Tabelle', table, 'antippen für die Teams');
}

// tournament: per stage a table (W-L) and the matches; knockouts as a bracket by day
const mgrName = id => (((L() && L().managers) || []).find(m => m.id === id) || {}).name || id;
// ── Bingo ─────────────────────────────────────────────────────────────────
// The minigame: a real bingo - one pool of stats, a 5x5 card per manager.
// Squares tick themselves as the games land - nothing to submit, nothing for
// the admin to answer. A card is drawn from the event + manager id, so it is
// personal but stable, and the same card shows on every device.
function evBingo(slug) {
  const d = evD(slug), ev = L().events[slug];
  if (!d) return card('Bingo', '<div class="empty">lädt …</div>');
  const all = S.eventBingoAll(L(), ev, d), mgrs = L().managers || [];
  if (!mgrs.length) return card('Event-Bingo', '<div class="empty">Noch keine Mitspieler.</div>');
  // whose card: my own; the admin (and anyone who taps the table) can look at the others
  if (!EVX.bingoCard || !all[EVX.bingoCard]) EVX.bingoCard = all[me()] ? me() : mgrs[0].id;
  const who = EVX.bingoCard, own = who === me();
  const b = all[who], sc = b.score, hits = b.hits;
  const inLine = new Set(sc.lineCells.flat());
  const games = new Set((d.games || []).map(g => g.game)).size;
  const grid = `<div class="bingo">${b.card.cells.map((key, i) => {
    const sq = S.BINGO[key] || {}, h = hits[key] || {}, rare = (b.card.rare || []).includes(i);
    const cls = 'bg-cell' + (h.hit ? ' on' : '') + (inLine.has(i) ? ' line' : '') + (rare ? ' rare' : '');
    return `<div class="${cls}" title="${esc(sq.hint || '')}"><div class="bg-l">${esc(sq.label || key)}</div>
      <div class="bg-f">${rare ? '<span class="bg-star">★</span>' : '<span></span>'}${h.hit ? '<span class="bg-w">✓</span>' : `<span class="bg-r">${sq.rate ? Math.max(1, Math.round(sq.rate * 100)) + '%' : ''}</span>`}</div></div>`;
  }).join('')}</div>`;
  // the moments: which game ticked which square, newest first
  const byGame = new Map();
  for (const r of d.games || []) { if (!byGame.has(r.game)) byGame.set(r.game, []); byGame.get(r.game).push(r); }
  const champ = id => ((app.D.champs || {}).names || {})[id] || id;
  const moments = b.card.cells.filter(k => (hits[k] || {}).hit).map(k => ({ k, h: hits[k] }))
    .sort((x, y) => String(y.h.at).localeCompare(String(x.h.at))).map(({ k, h }) => {
      const sq = S.BINGO[k] || {}, g = byGame.get(h.game) || [];
      const teams = [...new Set(g.map(x => x.team))], min = g[0] && g[0].dur ? Math.round(g[0].dur / 60) : null;
      const w = g.find(x => x.win);
      let who = '';
      try { const x = sq.who && sq.who(g); if (x) who = `<b>${esc(x.ign || (evP(slug, x.player) || {}).name || '')}</b> (${esc(champ(x.champ))}) ${x.k}/${x.d}/${x.a}${x.cs >= 400 ? ' · ' + x.cs + ' CS' : ''} · `; } catch (e) { /* no detail */ }
      return `<div class="row" style="gap:10px;padding:9px 16px;border-top:1px solid var(--line);align-items:flex-start">
        <span style="font-size:16px">${(b.card.rare || []).includes(b.card.cells.indexOf(k)) ? '★' : '✓'}</span>
        <div style="flex:1;min-width:0"><b>${esc(sq.label || k)}</b><div class="dim" style="font-size:12px">${who}${teams.map(c => evLogo(slug, c, 14) + ' ' + esc(c)).join(' vs ')}${min ? ' · ' + min + ' Min' : ''}${w ? ' · Sieg ' + esc(w.team) : ''}${h.at ? ' · ' + esc(new Date(h.at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })) : ''}</div></div></div>`;
    }).join('');
  const anyHit = Object.values(all).some(x => x.score.squares);
  const reshuffle = adminOnly() && !anyHit ? ` <button class="btn sm" id="bgShuffle">🎲 Neue Karten</button>` : '';
  const ranking = Object.values(all).sort((x, y) => y.score.points - x.score.points || y.score.lines - x.score.lines || y.score.squares - x.score.squares);
  const table = `<table><thead><tr><th>#</th><th>Karte</th><th class="num">Linien</th><th class="num">Felder</th><th class="num">Punkte</th></tr></thead><tbody>${ranking.map((x, i) =>
      `<tr class="${x.manager === me() ? 'me' : ''}" data-bgcard="${esc(x.manager)}" style="cursor:pointer"><td class="rank r${i + 1}">${i + 1}</td>
        <td class="fill"><b>${esc(mgrName(x.manager))}</b>${x.manager === who ? ' <span class="pill gold">angezeigt</span>' : ''}${x.score.full ? ' <span class="pill live">VOLL</span>' : ''}</td>
        <td class="num">${x.score.lines}</td><td class="num">${x.score.squares}</td><td class="num pts">${fmt(x.score.points)}</td></tr>`).join('')}</tbody></table>`;
  return card(own ? 'Meine Bingo-Karte' : 'Bingo-Karte von ' + esc(mgrName(who)), `<div class="card-b row" style="gap:14px;flex-wrap:wrap;align-items:baseline">
       <span><b style="font-size:20px">${sc.lines}</b> <span class="dim">${sc.lines === 1 ? 'Linie' : 'Linien'}</span></span>
       <span><b>${sc.squares}</b><span class="dim">/25 Felder</span></span>
       <span><b class="pts">+${fmt(sc.points)}</b> <span class="dim">Punkte</span></span>${sc.full ? '<span class="pill live">VOLLE KARTE</span>' : ''}
       <span class="dim" style="font-size:12px;flex:1;text-align:right">${games ? games + ' Spiele' : 'noch kein Spiel'}${reshuffle}</span></div>${grid}
     <div class="card-b dim" style="font-size:12px;border-top:1px solid var(--line)">Jeder hat seine eigene Karte aus demselben Pool von ${Object.keys(S.BINGO).length} Stats. Felder haken sich selbst ab, sobald ein Spiel sie erfüllt — auch rückwirkend.
       Jede volle Linie (Reihe, Spalte, Diagonale) auf <b>deiner</b> Karte: <b>+${b.cfg.line}</b>, volle Karte +${b.cfg.full}. ★ = selten — jede Reihe hat eins.</div>`, `+${b.cfg.line} pro Linie`)
    + card('Bingo-Tabelle', table, 'antippen = Karte ansehen')
    + card(own ? 'Momente auf deiner Karte' : 'Momente auf dieser Karte', moments || '<div class="empty">Noch nichts abgehakt. Hier steht, welches Spiel welches Feld abgehakt hat.</div>');
}

// ── Rift-Monopoly ─────────────────────────────────────────────────────────
// The board is replayed from the real games every time (scoring.js
// eventMonopoly); the page only shows it and saves pilot / buy rule.
const MONO_COLORS = ['#e8b04b', '#4fc3f7', '#ef5350', '#66bb6a', '#ab47bc', '#ff8a65', '#26c6da', '#d4e157', '#ec407a', '#8d6e63'];
const MONO_ICON = { start: '⬢', baron: '🐛', elder: '🐉', jail: '⏸', tax: '♻', pot: '⛲', card: '🃏' };
const MONO_RULES = [['all', 'Alles kaufen'], ['top', 'Nur LCK & LPL'], ['lec', 'Nur LEC'], ['none', 'Nichts kaufen']];
function monoRing(n) {
  // field i -> [row, col] on a k x k grid, clockwise from the bottom-right corner (Monopoly style)
  const k = (n + 4) / 4, pos = [];
  for (let i = 0; i < k; i++) pos.push([k, k - i]);              // bottom row, right -> left
  for (let i = 1; i < k; i++) pos.push([k - i, 1]);              // left column, bottom -> top
  for (let i = 1; i < k; i++) pos.push([1, 1 + i]);              // top row, left -> right
  for (let i = 1; i < k - 1; i++) pos.push([1 + i, k]);          // right column, top -> bottom
  return { k, pos };
}
function evMono(slug) {
  const d = evD(slug), ev = L().events[slug];
  if (!d) return card('Monopoly', '<div class="empty">lädt …</div>');
  if (!d.teams.length) return card('Rift-Monopoly', '<div class="empty">Das Brett entsteht, sobald die Teilnehmer feststehen.</div>');
  const m = S.eventMonopoly(L(), ev, d), mgrs = (L().managers || []).map(x => x.id).sort();
  const color = id => MONO_COLORS[mgrs.indexOf(id) % MONO_COLORS.length];
  const initial = id => esc(String(mgrName(id) || '?').trim().slice(0, 1).toUpperCase());
  const { k, pos } = monoRing(m.board.length);
  const at = {};
  for (const r of m.table) (at[r.pos] = at[r.pos] || []).push(r.manager);
  const cells = m.board.map((f, i) => {
    const [row, col] = pos[i], o = f.kind === 'team' ? m.owner[f.code] : null;
    const tokens = (at[i] || []).map(id => `<span class="mono-tok" style="background:${color(id)}" title="${esc(mgrName(id))}">${initial(id)}</span>`).join('');
    const inner = f.kind === 'team'
      ? `${evLogo(slug, f.code, 22)}<span class="mono-c">${esc(f.code)}</span><span class="mono-p">${f.price}</span>`
      : `<span class="mono-i">${MONO_ICON[f.kind] || '•'}</span><span class="mono-c">${esc(f.name)}</span>`;
    return `<div class="mono-cell ${f.kind}" style="grid-row:${row};grid-column:${col};${o ? `border-top:4px solid ${color(o)}` : ''}" title="${esc(f.name + (o ? ' · ' + mgrName(o) : ''))}">${inner}<div class="mono-toks">${tokens}</div></div>`;
  }).join('');
  const info = evInfo(slug) || {};
  const center = `<div class="mono-center" style="grid-row:2 / ${k};grid-column:2 / ${k}">${info.logo ? `<img src="${esc(info.logo)}" alt="">` : ''}
    <div class="mono-title">Rift-Monopoly</div><div class="dim" style="font-size:11px">Fountain: ${m.pot}</div></div>`;
  const board = `<div class="mono-board" style="grid-template-columns:repeat(${k},minmax(0,1fr));grid-template-rows:repeat(${k},minmax(0,1fr))">${cells}${center}</div>`;
  // me
  let mine = '';
  if (!adminOnly()) {
    const r = m.table.find(x => x.manager === me()) || {};
    const choices = ((ev.mono || {}).choices || {})[me()] || [];
    const rule = (choices.filter(c => c.rule).pop() || {}).rule || 'all';
    const pilotP = evP(slug, r.pilot) || {};
    const opts = d.teams.map(t => `<optgroup label="${esc(t.code)}">${d.players.filter(p => p.team === t.code).map(p => `<option value="${esc(p.id)}" ${p.id === r.pilot ? 'selected' : ''}>${esc(p.name)} · ${p.role}</option>`).join('')}</optgroup>`).join('');
    mine = card('Du', `<div class="card-b row" style="gap:16px;flex-wrap:wrap;align-items:baseline">
        <span><b style="font-size:20px">${r.cash ?? 0}</b> <span class="dim">Gold</span></span><span><b>${r.worth ?? 0}</b> <span class="dim">Wert</span></span>
        <span class="dim">Feld: <b style="color:var(--text)">${esc((m.board[r.pos || 0] || {}).name || (m.board[r.pos || 0] || {}).code || '')}</b></span>
        <span>${(r.props || []).map(c => evLogo(slug, c, 18)).join(' ') || '<span class="dim">noch kein Team</span>'}</span></div>
      <div class="card-b" style="border-top:1px solid var(--line)"><label style="margin-top:0">Dein Pilot — seine Spiele sind deine Würfel (Kills + halbe Assists, 6+ Tode = 3 zurück)</label>
        <div class="row" style="gap:8px;flex-wrap:wrap">${pilotP.photo ? `<img class="ph" src="${esc(pilotP.photo)}" alt="">` : ''}<select id="monoPilot" style="flex:1;min-width:160px">${opts}</select><button class="btn sm gold" id="monoPilotSave">Pilot setzen</button></div>
        <div class="dim" style="font-size:12px;margin-top:6px">Gilt ab dem nächsten Spiel. Spielt sein Team nicht, stehst du.</div>
        <label>Kaufen, wenn du auf ein freies Team kommst</label>
        <div class="chips">${MONO_RULES.map(([v, l]) => `<button class="chip ${rule === v ? 'on' : ''}" data-monorule="${v}">${l}</button>`).join('')}</div></div>`);
  }
  const table = card('Stand', `<table><tbody>${m.table.map((r, i) => `<tr class="${r.manager === me() ? 'me' : ''}"><td class="rank">${i + 1}</td>
      <td class="fill"><span class="mono-tok" style="background:${color(r.manager)}">${initial(r.manager)}</span> <b>${esc(r.name)}</b>
        <div class="dim" style="font-size:11px">Pilot: ${esc((evP(slug, r.pilot) || {}).name || '—')} · ${r.props.length} Teams${r.jail ? ' · ⏸ Grey Screen' : ''}</div></td>
      <td class="num">${r.cash}</td><td class="num pts">${r.worth}</td></tr>`).join('')}</tbody></table>`, 'Gold · Wert');
  const feed = card('Züge', m.log.length ? m.log.slice(0, 40).map(l => `<div class="row" style="gap:8px;padding:7px 16px;border-top:1px solid var(--line);align-items:flex-start;font-size:13px">
      <span class="mono-tok" style="background:${color(l.manager)}">${initial(l.manager)}</span><div style="flex:1;min-width:0">${esc(l.text)}</div></div>`).join('')
    : '<div class="empty">Noch kein Zug — sobald die Piloten spielen, laufen die Figuren.</div>');
  return `<div class="grid g-main"><div class="stack">${card('Brett', board, 'kein Punktewert — Test')}${feed}</div><div class="stack">${mine}${table}
    ${card('Rift-Karten', `<div class="card-b dim" style="font-size:12px;line-height:1.7">${m.cards.map(c => '🃏 ' + esc(c.text)).join('<br>')}</div>`)}</div></div>`;
}

// ── Tippspiel: every match of the event ───────────────────────────────────
function evTipChips(slug, e, mine, open) {
  const scores = S.tipScores(e.bestOf), a = e.teams[0].code, b = e.teams[1].code;
  if ((e.bestOf || 1) <= 1) return `<div class="tipchips">${scores.map(sc => { const winA = sc === '1:0';
    return `<button class="tipchip ${mine === sc ? 'on' : ''}" ${open ? `data-tip="${esc(e.match)}" data-sc="${sc}"` : 'disabled'}>${evLogo(slug, winA ? a : b, 16)} ${esc(winA ? a : b)}</button>`; }).join('')}</div>`;
  const cols = scores.length > 4 ? scores.length / 2 : scores.length;
  return `<div class="tipchips" style="display:grid;grid-template-columns:repeat(${cols},1fr)">${scores.map(sc => `<button class="tipchip ${mine === sc ? 'on' : ''}" ${open ? `data-tip="${esc(e.match)}" data-sc="${sc}"` : 'disabled'}>${sc}</button>`).join('')}</div>`;
}
function evTips(slug) {
  const ev = L().events[slug], d = evD(slug), now = Date.now();
  const mine = EVX.mt[slug] || (EVX.mine[slug] && EVX.mine[slug].matchTips) || {};
  const revealed = ev.tips || {}, stages = S.eventStages(d);
  const rows = S.eventStandings(L(), ev, d), meRow = rows.find(r => r.manager === me()) || {};
  const c = S.tipConfig(ev);
  const open = (d.schedule || []).filter(e => S.tipOpen(e, now));
  const missing = open.filter(e => !mine[e.match]).length;
  const head = adminOnly() ? '' : card('Mein Tippspiel', `<div class="card-b row" style="gap:18px;flex-wrap:wrap;align-items:baseline">
      <span><b style="font-size:22px">${meRow.tips || 0}</b> <span class="dim">Punkte</span></span>
      <span><b>${(meRow.tipStats || {}).right || 0}</b> <span class="dim">richtig</span></span><span><b>${(meRow.tipStats || {}).exact || 0}</b> <span class="dim">exakt</span></span>
      <span style="flex:1;text-align:right">${missing ? `<span class="pill live">${missing} offen zu tippen</span>` : open.length ? '<span class="pill teal">alles getippt ✓</span>' : ''}</span></div>
    <div class="card-b dim" style="font-size:12px;border-top:1px solid var(--line)">Bo1: richtiger Sieger ${c.bo1} · Bo3/Bo5: richtiger Sieger ${c.winner}, genaues Ergebnis +${c.exact} · K.-o.-Phase ×${c.koFactor}.
      Tippen bis zum Spielbeginn, danach sehen alle die Tipps. Neue Paarungen erscheinen von selbst.</div>`);
  const day = iso => new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit' });
  const time = iso => new Date(iso).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  const body = stages.map(st => {
    const ms = (d.schedule || []).filter(e => e.stage === st.i).sort((x, y) => x.start.localeCompare(y.start));
    if (!ms.length) return '';
    const known = ms.filter(S.tipKnown).length, openN = ms.filter(e => S.tipOpen(e, now)).length;
    let lastDay = '';
    const list = ms.map(e => {
      const k = S.tipKnown(e), isOpen = S.tipOpen(e, now), my = mine[e.match] || (revealed[e.match] || {})[me()];
      const pts = S.tipPoints(ev, d, e, my);
      const dd = day(e.start), sep = dd !== lastDay ? `<div class="tipday">${esc(dd)}</div>` : ''; lastDay = dd;
      if (!k) return sep + `<div class="tiprow tbd"><span class="tiptime">${time(e.start)}</span><span class="dim">Paarung steht noch nicht fest · Bo${e.bestOf || 1}</span></div>`;
      const [ta, tb] = e.teams, done = e.state === 'completed', live = !done && !isOpen;
      const res = done ? `<b class="num">${ta.wins ?? ''}:${tb.wins ?? ''}</b>` : live ? '<span class="pill live">läuft</span>' : `<span class="dim">Bo${e.bestOf || 1}</span>`;
      const badge = pts === null ? '' : `<span class="tippts ${pts > 0 ? 'ok' : ''}">${pts > 0 ? '+' + pts : '0'}</span>`;
      const others = !isOpen && EVX.openMatch === e.match ? `<div class="tipothers">${(L().managers || []).map(m => { const t = (revealed[e.match] || {})[m.id], p2 = S.tipPoints(ev, d, e, t);
          return `<span><b>${esc(m.name)}</b> ${t ? esc(t) : '—'}${p2 ? ` <span class="tippts ok">+${p2}</span>` : ''}</span>`; }).join('')}</div>` : '';
      return sep + `<div class="tiprow ${isOpen ? 'open' : 'locked'}" ${!isOpen ? `data-tipopen="${esc(e.match)}"` : ''}>
        <span class="tiptime">${time(e.start)}</span>
        <span class="tipteam">${evLogo(slug, ta.code, 20)} <b>${esc(ta.code)}</b></span><span class="tipres">${res}</span><span class="tipteam r"><b>${esc(tb.code)}</b> ${evLogo(slug, tb.code, 20)}</span>
        ${adminOnly() ? '' : `<div class="tipmine">${isOpen ? evTipChips(slug, e, my, true) : `<span class="dim" style="font-size:12px">Dein Tipp: <b style="color:var(--text)">${my ? esc(my) : '—'}</b></span> ${badge}`}</div>`}
        ${others}</div>`;
    }).join('');
    return card(esc(st.name), list, openN ? `${openN} offen` : known < ms.length ? 'Paarungen folgen' : st.done ? 'beendet' : '');
  }).join('');
  return head + body;
}

// ── Live: every game of the event, straight from the lolesports feed ─────
// Scoreboard, champions, K/D/A, CS, gold, items, damage share, dragons - live
// (the feed lags the stream by a few minutes) and for finished games. The feed
// has no draft: bans come from Leaguepedia (entered by hand a few minutes
// after a game). Asked here once per game; the stats job also stores them in
// the event file (d.bans) every 2 hours, so they always arrive.
const LV = { match: null, pinned: false, sel: {}, selUser: {}, det: {}, game: {}, t0: {}, lag: {}, lp: {}, lpWait: 0, busy: {}, tried: {}, inv: null };
const LGW = 'https://esports-api.lolesports.com/persisted/gw/', LFEED = 'https://feed.lolesports.com/livestats/v1/', LKEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const LADDER = [60, 120, 180, 240, 300, 420, 600, 900];
const TRINKETS = new Set([3340, 3363, 3364, 3330, 3513]);
const DRAGON_DE = { infernal: 'Infernal', ocean: 'Ozean', mountain: 'Berg', cloud: 'Wolken', hextech: 'Hextech', chemtech: 'Chemtech', elder: 'Älteste' };
const lvStamp = ms => { const x = new Date(ms); x.setMilliseconds(0); x.setSeconds(x.getSeconds() - x.getSeconds() % 10); return x.toISOString().replace('.000Z', 'Z'); };
async function lvJson(url, headers) {
  const r = await fetch(url, headers ? { headers } : undefined).catch(() => null);
  if (!r || !r.ok) return null;          // 400 = "that moment is not in the feed yet"
  const t = await r.text();
  try { return t ? JSON.parse(t) : null; } catch (e) { return null; }
}
// one async load at a time per key, never more often than every 15 s
function lvKick(key, fn) {
  if (LV.busy[key] || Date.now() - (LV.tried[key] || 0) < 15000) return;
  LV.busy[key] = true; LV.tried[key] = Date.now();
  fn().catch(() => {}).finally(() => { delete LV.busy[key]; if (EVX.tab === 'live' && /^\/event\//.test(path())) render(); });
}
// the games of one match
async function lvMatch(id) {
  const j = await lvJson(LGW + 'getEventDetails?hl=en-US&id=' + id, { 'x-api-key': LKEY });
  const m = j && j.data && j.data.event && j.data.event.match;
  if (!m) return;
  LV.det[id] = { at: Date.now(), teams: (m.teams || []).map(t => ({ id: t.id, code: t.code })),
    games: (m.games || []).filter(g => g.state === 'completed' || g.state === 'inProgress').map(g => ({ id: g.id, n: g.number, state: g.state })) };
}
async function lvAt(gid, at) {
  const [w, dt] = await Promise.all([lvJson(`${LFEED}window/${gid}?startingTime=${at}`), lvJson(`${LFEED}details/${gid}?startingTime=${at}`)]);
  if (!w || !w.frames || !w.frames.length) return null;
  return { meta: w.gameMetadata, frame: w.frames[w.frames.length - 1], det: dt && dt.frames && dt.frames.length ? dt.frames[dt.frames.length - 1] : null };
}
// live: the newest moment the feed has; finished: its last frame
async function lvGame(gid, finished) {
  if (LV.game[gid] && LV.game[gid].done) return;
  if (!LV.t0[gid]) {
    const w0 = await lvJson(LFEED + 'window/' + gid);
    if (!w0 || !w0.frames || !w0.frames.length) return;
    LV.t0[gid] = Date.parse(w0.frames[0].rfc460Timestamp);
  }
  const t0 = LV.t0[gid];
  let g = null;
  if (finished) {
    // past the end the feed keeps answering with the last frame; a game that
    // never says "finished" (surrender, feed cut) ends where frames stop moving
    let prev = null;
    for (const m of [70, 100, 140]) {
      const x = await lvAt(gid, lvStamp(t0 + m * 60e3));
      if (!x) continue;
      g = x;
      if (x.frame.gameState === 'finished' || x.frame.rfc460Timestamp === prev) break;
      prev = x.frame.rfc460Timestamp;
    }
  } else {
    for (const back of LADDER.slice(Math.max(0, LADDER.indexOf(LV.lag[gid] || 60) - 1))) {
      const x = await lvAt(gid, lvStamp(Date.now() - back * 1000));
      if (x) { LV.lag[gid] = back; g = x; break; }
    }
  }
  if (!g) return;
  g.at = Date.now(); g.t0 = t0;
  g.done = finished || g.frame.gameState === 'finished';
  LV.game[gid] = g;
}
const lvNorm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function lvChamp(name) {
  if (!LV.inv) { LV.inv = {}; for (const [id, n] of Object.entries((app.D.champs && app.D.champs.names) || {})) { LV.inv[lvNorm(n)] = id; LV.inv[lvNorm(id)] = id; } }
  return LV.inv[lvNorm(name)] || null;
}
const lvChamps = list => String(list || '').split(',').map(lvChamp).filter(Boolean);
// Leaguepedia, for a finished game: { bans: { [code]: [champ ids] }, win: code }
async function lvBans(gid, g, cb, cr) {
  if (Date.now() < LV.lpWait) return;
  const f = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const q = new URLSearchParams({ action: 'cargoquery', format: 'json', origin: '*', tables: 'ScoreboardGames', limit: '40',
    fields: 'Team1Bans,Team2Bans,Team1Picks,Team2Picks,Winner', where: `DateTime_UTC >= "${f(g.t0 - 4 * 36e5)}" AND DateTime_UTC <= "${f(g.t0 + 4 * 36e5)}"` });
  const j = await lvJson('https://lol.fandom.com/api.php?' + q);
  if (!j || j.error) { if (j && j.error && j.error.code === 'ratelimited') LV.lpWait = Date.now() + 10 * 60e3; return; }
  const side = sd => new Set(g.meta[sd + 'TeamMetadata'].participantMetadata.map(x => x.championId));
  const blue = side('blue'), red = side('red');
  const hits = (list, set) => lvChamps(list).filter(c => set.has(c)).length;
  for (const r of (j.cargoquery || []).map(x => x.title)) {
    for (const [a, b] of [['Team1', 'Team2'], ['Team2', 'Team1']]) {
      if (hits(r[a + 'Picks'], blue) >= 4 && hits(r[b + 'Picks'], red) >= 4) {
        const w = String(r.Winner || '');
        LV.lp[gid] = { bans: { [cb]: lvChamps(r[a + 'Bans']), [cr]: lvChamps(r[b + 'Bans']) }, win: w === (a === 'Team1' ? '1' : '2') ? cb : w ? cr : null };
        return;
      }
    }
  }
}
function evLive(slug) {
  const d = evD(slug), now = Date.now(), ev = L().events[slug];
  const day = iso => new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' });
  const known = (d.schedule || []).filter(S.tipKnown);
  const running = known.filter(e => e.state === 'inProgress');
  const list = running.concat(known.filter(e => e.state === 'completed').sort((a, b) => b.start.localeCompare(a.start)));
  if (!list.length) {
    const next = (d.schedule || []).filter(e => e.state === 'unstarted').sort((a, b) => a.start.localeCompare(b.start))[0];
    return card('Live', `<div class="empty">Noch kein Spiel gelaufen.${next ? ` Los geht's ${esc(day(next.start))} um ${esc(new Date(next.start).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }))} Uhr.` : ''}<br>
      Hier läuft dann jedes Spiel mit: Champions, K/D/A, Items, Gold, Türme, Drachen — und die Bans.</div>`);
  }
  if (!LV.pinned || !list.find(e => e.match === LV.match)) { LV.match = list[0].match; LV.pinned = false; }
  const e = list.find(x => x.match === LV.match), live = e.state === 'inProgress';
  const strip = `<div class="lvstrip">${list.map(x => `<button class="lvm ${x.match === e.match ? 'on' : ''}" data-lvm="${esc(x.match)}">
      <span class="lvm-t">${evLogo(slug, x.teams[0].code, 18)}<b>${x.teams[0].wins ?? 0}:${x.teams[1].wins ?? 0}</b>${evLogo(slug, x.teams[1].code, 18)}</span>
      <small>${x.state === 'inProgress' ? '<span class="live-dot"></span> live' : esc(day(x.start))}</small></button>`).join('')}</div>`;
  const det = LV.det[e.match];
  if (!det || live && now - det.at > 30000 || !live && det.games.some(g => g.state === 'inProgress')) lvKick('m' + e.match, () => lvMatch(e.match));
  const title = `${esc(e.teams[0].code)} ${e.teams[0].wins ?? 0}:${e.teams[1].wins ?? 0} ${esc(e.teams[1].code)} · Bo${e.bestOf || 1}`;
  if (!det) return strip + card(title, '<div class="empty">lädt …</div>');
  if (!det.games.length) return strip + card(title, '<div class="empty">Gleich geht\'s los — der Live-Feed kommt ein paar Minuten nach dem Stream.</div>');
  let gid = LV.sel[e.match];
  const cur = det.games.find(g => g.state === 'inProgress') || det.games[det.games.length - 1];
  if (!gid || !LV.selUser[e.match] || !det.games.find(g => g.id === gid)) gid = cur.id;
  const gm = det.games.find(g => g.id === gid), g = LV.game[gid];
  const finished = gm.state === 'completed' || !!ev.replay;
  if (!g || !g.done && now - g.at > 20000) lvKick('g' + gid, () => lvGame(gid, finished));
  const gtabs = det.games.length > 1 || e.bestOf > 1 ? `<div class="chips" style="margin:0 0 12px">${det.games.map(x => `<button class="chip ${x.id === gid ? 'on' : ''}" data-lvg="${esc(x.id)}" data-lvmatch="${esc(e.match)}">${x.state === 'inProgress' ? '<span class="live-dot"></span> ' : ''}Spiel ${x.n}</button>`).join('')}</div>` : '';
  return strip + `<div class="eyebrow" style="margin:4px 0 10px">${title}</div>` + gtabs + (g ? lvGameView(slug, e, gid, g, det) : card('Spiel ' + gm.n, `<div class="empty">${LV.tried['g' + gid] && !LV.busy['g' + gid] ? (finished ? 'Für dieses Spiel hat der Feed keine Daten.' : 'Der Live-Feed startet ein paar Minuten nach Spielbeginn — gleich geht es los.') : 'lädt Spieldaten …'}</div>`));
}
function lvGameView(slug, e, gid, g, det) {
  const d = evD(slug), { meta, frame } = g;
  const code = sd => (det.teams.find(t => t.id === meta[sd + 'TeamMetadata'].esportsTeamId) || {}).code || (sd === 'blue' ? 'Blau' : 'Rot');
  const cb = code('blue'), cr = code('red'), fb = frame.blueTeam, fr = frame.redTeam;
  // bans + winner: the event file first, else Leaguepedia (finished games only)
  const fileBans = (d.bans || {})[gid];
  if (g.done && !fileBans && !(LV.lp[gid] && LV.lp[gid].bans)) lvKick('b' + gid, () => lvBans(gid, g, cb, cr));
  const lp = LV.lp[gid] || {}, bans = fileBans || lp.bans || null;
  const winRow = (d.games || []).find(r => r.game === gid && r.win);
  const win = g.done ? (winRow ? winRow.team : lp.win || null) : null;
  const mins = Math.max(0, (Date.parse(frame.rfc460Timestamp) - g.t0) / 60e3);
  const clock = `${Math.floor(mins)}:${String(Math.floor(mins % 1 * 60)).padStart(2, '0')}`;
  const lag = Math.max(0, Math.round((Date.now() - Date.parse(frame.rfc460Timestamp)) / 60e3));
  const k = n => (n / 1000).toFixed(1).replace('.', ',') + 'k';
  const share = fb.totalGold + fr.totalGold ? fb.totalGold / (fb.totalGold + fr.totalGold) * 100 : 50;
  const diff = fb.totalGold - fr.totalGold;
  const drag = l => (l || []).map(t => `<span class="lvdrag d-${esc(t)}" title="${esc(DRAGON_DE[t] || t)}"></span>`).join('') || '<span class="dim">—</span>';
  const stat = (a, label, b) => `<div class="lvst"><span>${a}</span><span class="dim">${label}</span><span>${b}</span></div>`;
  const banRow = c => bans && bans[c] && bans[c].length ? bans[c].map(x => `<span class="lvban">${U.champIcon(app.D, x, 26)}</span>`).join('') : '';
  const banNote = bans ? '' : `<div class="dim" style="font-size:12px;text-align:center;padding:4px 0 2px">${g.done ? 'Bans folgen, sobald Leaguepedia das Spiel eingetragen hat (meist ein paar Minuten).' : 'Bans gibt es nach dem Spiel (der Live-Feed hat keinen Draft).'}</div>`;
  const head = card(g.done ? 'Endstand' : '<span class="live-dot"></span>&nbsp; Live', `<div class="card-b">
      <div class="lvscore">
        <div class="lvside">${evLogo(slug, cb, 40)}<b>${esc(cb)}</b>${win === cb ? '<span class="pill gold">Sieg</span>' : ''}<small class="dim">blau</small></div>
        <div class="lvmid"><div class="lvk">${fb.totalKills}<span>:</span>${fr.totalKills}</div><div class="dim" style="font-size:12px">${clock}${g.done ? '' : ` · Stand vor ${lag || '<1'} min`}</div></div>
        <div class="lvside">${evLogo(slug, cr, 40)}<b>${esc(cr)}</b>${win === cr ? '<span class="pill gold">Sieg</span>' : ''}<small class="dim">rot</small></div>
      </div>
      <div class="lvbar"><span style="width:${share.toFixed(1)}%"></span></div>
      ${stat(k(fb.totalGold), `Gold ${diff ? (diff > 0 ? '◀ +' : '+') + k(Math.abs(diff)) + (diff < 0 ? ' ▶' : '') : ''}`, k(fr.totalGold))}
      ${stat(fb.towers, 'Türme', fr.towers)}${stat(fb.inhibitors, 'Inhibitoren', fr.inhibitors)}${stat(fb.barons, 'Barone', fr.barons)}
      ${stat(`<span class="lvdrags">${drag(fb.dragons)}</span>`, 'Drachen', `<span class="lvdrags r">${drag(fr.dragons)}</span>`)}
      ${bans ? `<div class="lvst lvbans"><span>${banRow(cb)}</span><span class="dim">Bans</span><span>${banRow(cr)}</span></div>` : banNote}
    </div>`, g.done ? '' : 'alle 20 s');
  const ver = app.D.champs && app.D.champs.version;
  const byPid = Object.fromEntries(((g.det && g.det.participants) || []).map(x => [x.participantId, x]));
  const team = sd => {
    const md = meta[sd + 'TeamMetadata'], fp = Object.fromEntries(frame[sd + 'Team'].participants.map(x => [x.participantId, x])), c = code(sd);
    const rows = md.participantMetadata.map(pm => {
      const p = Object.assign({}, fp[pm.participantId] || {}, byPid[pm.participantId] || {});
      const pl = evP(slug, pm.esportsPlayerId);
      const name = pl ? pl.name : String(pm.summonerName || '?').replace(new RegExp('^' + c + '\\s+'), '');
      const items = (p.items || []).filter(x => !TRINKETS.has(x)).concat((p.items || []).filter(x => TRINKETS.has(x)));
      const champName = (app.D.champs.names || {})[pm.championId] || pm.championId;
      return `<div class="lvp">
        <div class="lvc">${U.champIcon(app.D, pm.championId, 36)}<span class="lvlvl">${p.level || ''}</span></div>
        <div class="lvn"><b>${esc(name)}</b><small class="dim">${esc(champName)}${pm.role ? ' · ' + esc(String(pm.role).toUpperCase().replace('JUNGLE', 'JNG').replace('BOTTOM', 'BOT').replace('SUPPORT', 'SUP')) : ''}</small></div>
        <div class="lvkda"><b>${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}</b><small class="dim">${p.creepScore ?? 0} CS · ${k(p.totalGoldEarned || p.totalGold || 0)}${p.championDamageShare ? ' · ' + Math.round(p.championDamageShare * 100) + '% Dmg' : ''}</small></div>
        <div class="lvitems">${ver ? items.map(x => `<img src="https://ddragon.leagueoflegends.com/cdn/${ver}/img/item/${x}.png" alt="" width="22" height="22" loading="lazy" onerror="this.style.visibility='hidden'">`).join('') : ''}</div>
      </div>`;
    }).join('');
    return card(`${evLogo(slug, c, 22)} ${esc(c)}`, rows, `${frame[sd + 'Team'].totalKills} Kills`);
  };
  return head + `<div class="grid g-2" style="margin-top:14px">${team('blue')}${team('red')}</div>`;
}
// while a live game is on screen: refresh every 20 s
setInterval(() => {
  if (EVX.tab !== 'live' || document.hidden || !/^\/event\//.test(path())) return;
  const g = LV.game[LV.sel[LV.match] || ''] || Object.values(LV.game).find(x => !x.done);
  if (!g || !g.done) render();
}, 20000);

function evTour(slug) {
  const d = evD(slug), stages = S.eventStages(d);
  if (!stages.length) return card('Turnier', '<div class="empty">Spielplan kommt noch.</div>');

  // One match row. Teams sit in fixed-width cells so every row lines up and the
  // score column never jumps around when a code is short (G2) or long (MKOI).
  const mt = e => {
    const done = e.state === 'completed';
    const mid = done ? `${e.teams[0] && e.teams[0].wins != null ? e.teams[0].wins : ''}<span class="evm-x">:</span>${e.teams[1] && e.teams[1].wins != null ? e.teams[1].wins : ''}`
      : e.state === 'inProgress' ? '<span class="evm-live">live</span>' : '<span class="evm-vs">vs</span>';
    const side = (t, right) => {
      const known = t && t.code && t.code !== 'TBD';
      return `<span class="evm-t${right ? ' r' : ''}${t && t.outcome === 'loss' ? ' lost' : ''}">`
        + (right ? '' : (known ? `<b>${esc(t.code)}</b>` : '<span class="dim">TBD</span>'))
        + (known ? evLogo(slug, t.code, 18) : (right ? '<span class="dim">TBD</span>' : ''))
        + (right && known ? `<b>${esc(t.code)}</b>` : '') + '</span>';
    };
    return `<div class="evm${done ? ' done' : ''}">
      <time class="evm-d">${esc(new Date(e.start).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</time>
      ${side(e.teams[0], false)}<span class="evm-s">${mid}</span>${side(e.teams[1], true)}</div>`;
  };

  return stages.map(s => {
    const ev = d.schedule.filter(e => e.stage === s.i).sort((a, b) => a.start.localeCompare(b.start));
    const rec = {};
    for (const e of ev) for (const t of e.teams) { if (!t.code || t.code === 'TBD') continue; const r = rec[t.code] || (rec[t.code] = { w: 0, l: 0 }); if (t.outcome === 'win') r.w++; if (t.outcome === 'loss') r.l++; }
    const ranked = Object.entries(rec).sort((a, b) => (b[1].w - b[1].l) - (a[1].w - a[1].l) || b[1].w - a[1].w);
    const isKo = s.i === stages.length - 1 && stages.length > 1;
    const isSwiss = /swiss/i.test(String(s.name || ''));
    const played = ranked.some(([, r]) => r.w || r.l);
    const note = s.done ? 'beendet' : s.lock ? (s.lock > Date.now() ? 'ab ' + esc(new Date(s.lock).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })) : 'läuft') : '';

    if (isKo) return card(esc(s.name), evBracket(slug, ev) || '<div class="empty">—</div>', note);
    if (isSwiss) return card(esc(s.name), evSwiss(slug, ev, ranked) || '<div class="empty">—</div>', note);

    // Standings and schedule are two different things - give each its own
    // panel with a heading instead of mashing them into one gapless grid.
    const table = ranked.length ? `<div class="evpanel">
        <div class="evpanel-h">Tabelle${played ? '' : ' <span class="dim">· noch keine Spiele</span>'}</div>
        <table class="tight evstand"><tbody>${ranked.map(([c, r], i) => `<tr><td class="rank">${i + 1}</td><td class="fill">${evLogo(slug, c, 20)} <b>${esc((evT(slug, c) || {}).name || c)}</b></td><td class="num pts">${r.w}–${r.l}</td></tr>`).join('')}</tbody></table></div>` : '';
    const list = ev.length ? `<div class="evpanel">
        <div class="evpanel-h">Spiele <span class="dim">· ${ev.length}</span></div>
        <div class="evmatches">${ev.map(mt).join('')}</div></div>` : '';
    const body = table && list ? `<div class="evtour">${table}${list}</div>` : (table || list);
    return card(esc(s.name), body || '<div class="empty">—</div>', note);
  }).join('');
}

// Swiss: a flat win-loss table is the wrong shape. What a Swiss stage is
// actually about is the bracket you are in - 2-0, 1-1, 0-2 - because that is
// who you get drawn against next, and at 3 wins you are through while at 3
// losses you are out. The schedule cannot tell us this (all Swiss pairings are
// TBD until they are drawn from results), so the records are derived from the
// games that have been played.
function evSwiss(slug, evs, ranked) {
  const WIN = 3, LOSS = 3;
  if (!ranked.length) return `<div class="empty">Die Swiss-Phase beginnt mit dem ersten Spiel — dann steht hier, wer in welcher Runde steht.</div>`;
  const groups = new Map();
  for (const [code, r] of ranked) {
    const key = r.w + '-' + r.l;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([code, r]);
  }
  const order = [...groups.keys()].sort((a, b) => {
    const [aw, al] = a.split('-').map(Number), [bw, bl] = b.split('-').map(Number);
    return (bw - aw) || (al - bl);
  });
  const label = key => {
    const [w, l] = key.split('-').map(Number);
    if (w >= WIN) return { t: 'Weiter', cls: 'sw-in', sub: `${w}-${l} · qualifiziert` };
    if (l >= LOSS) return { t: 'Raus', cls: 'sw-out', sub: `${w}-${l} · ausgeschieden` };
    return { t: `${w}-${l}`, cls: '', sub: w + l === 0 ? 'noch kein Spiel' : `${w + l} gespielt` };
  };
  return `<div class="swiss">${order.map(key => {
    const g = groups.get(key), lb = label(key);
    return `<div class="sw-g ${lb.cls}">
      <div class="sw-h"><b>${esc(lb.t)}</b><span class="dim">${esc(lb.sub)}</span><span class="sw-n">${g.length}</span></div>
      ${g.map(([code, r]) => `<div class="sw-t"><span class="sw-lg">${evLogo(slug, code, 20)}</span>
        <span class="sw-c">${esc((evT(slug, code) || {}).name || code)}</span>
        <span class="num dim">${r.w}–${r.l}</span></div>`).join('')}</div>`;
  }).join('')}</div>
  <div class="card-b dim" style="font-size:12px;border-top:1px solid var(--line)">
    Drei Siege = weiter, drei Niederlagen = raus. Die Paarungen werden jeweils innerhalb
    einer Runde ausgelost, deshalb stehen kommende Spiele erst kurz vorher fest.</div>`;
}

// knockout bracket rebuilt from the teams' path (the API links no matches):
// a team that lost (or came from the lower bracket) plays lower bracket, a
// round is 1 + the round of the team's previous match there, last = final
function evBracket(slug, ev) {
  const known = m => m.teams.length === 2 && m.teams.every(t => t.code && t.code !== 'TBD');
  const final = ev.length > 1 ? ev[ev.length - 1] : null;
  const last = new Map(), lost = new Set(), secs = { upper: [], lower: [], final: [], open: [] };
  for (const m of ev) {
    const sec = m === final ? 'final' : !known(m) ? 'open' : m.teams.some(t => lost.has(t.code) || (last.get(t.code) || {}).sec === 'lower') ? 'lower' : 'upper';
    let dep = 0;
    if (sec === 'upper' || sec === 'lower') for (const t of m.teams) { const l = last.get(t.code); if (l && l.sec === sec) dep = Math.max(dep, l.dep + 1); }
    (secs[sec][dep] = secs[sec][dep] || []).push(m);
    for (const t of m.teams) { last.set(t.code, { sec, dep }); if (t.outcome === 'loss') lost.add(t.code); }
  }
  const box = m => `<div class="card" style="margin-bottom:8px;min-width:170px">${m.teams.map(t => `<div class="row" style="padding:7px 10px;gap:8px;border-bottom:1px solid var(--line);${t.outcome === 'loss' ? 'opacity:.5' : ''}">${t.code && t.code !== 'TBD' ? evLogo(slug, t.code, 18) : ''}<b style="flex:1">${esc(t.code || 'TBD')}</b><b class="num">${t.wins ?? ''}</b></div>`).join('')}
      <div class="dim" style="font-size:11px;padding:4px 10px">${esc(new Date(m.start).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' }))}${m.state === 'inProgress' ? ' · <span style="color:var(--live)">live</span>' : ''}</div></div>`;
  const lane = (cols, name, lastName) => {
    cols = cols.filter(Boolean);
    if (!cols.length) return '';
    const label = i => lastName && cols.length > 1 && i === cols.length - 1 ? lastName : name + (cols.length > 1 ? ' · Runde ' + (i + 1) : '');
    return `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><div class="row" style="align-items:flex-start;gap:12px;min-width:max-content;padding:12px 16px 4px">
      ${cols.map((c, i) => `<div><div class="eyebrow" style="margin-bottom:6px">${esc(label(i))}</div>${c.map(box).join('')}</div>`).join('')}</div></div>`;
  };
  const champ = final && final.state === 'completed' && final.teams.find(t => t.outcome === 'win');
  const double = secs.lower.length > 0;
  return (champ ? `<div class="card-b" style="display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--line)">🏆 ${evLogo(slug, champ.code, 28)} <b>${esc((evT(slug, champ.code) || {}).name || champ.code)}</b> gewinnt</div>` : '')
    + lane(secs.upper, double ? 'Upper Bracket' : 'K.-o.', double ? 'Upper-Finale' : 'Halbfinale') + lane(secs.lower, 'Lower Bracket', 'Lower-Finale') + lane(secs.open, 'Noch offen') + lane(secs.final, 'Finale');
}

function evTeams(slug) {
  const ev = L().events[slug], d = evD(slug);
  return `<div class="grid g-3">${d.teams.map(t => `<section class="card"><div class="card-b row" style="gap:12px">${evLogo(slug, t.code, 44)}<div style="min-width:0;flex:1"><b style="font-size:16px">${esc(t.name)}</b>
      <div class="dim" style="font-size:12px">${esc(t.league || '')} · ${S.eventTeamPrice(ev, d, t.code)} Credits pro Spieler</div></div></div>
      <div class="card-b" style="border-top:1px solid var(--line);font-size:13px">${d.players.filter(p => p.team === t.code).map(p => `<span style="white-space:nowrap;margin-right:10px"><span class="dim">${p.role}</span> ${esc(p.name)}</span>`).join(' ')}</div></section>`).join('')}</div>`;
}

// home banner for the running/next event
function eventBanner() {
  const slug = currentEventSlug();
  if (!slug) return '';
  const ev = L().events[slug], info = evInfo(slug) || {}, t = evTheme(slug);
  const started = ev.replay ? Date.now() >= ev.replay.from : Date.parse(info.start) <= Date.now();
  return `<a href="#/event/${esc(slug)}" class="card evbanner" style="display:flex;gap:16px;align-items:center;padding:16px 18px;margin-bottom:16px;text-decoration:none;color:inherit;border-color:${t.accent};background:linear-gradient(110deg,${t.bg} 0%,rgba(${t.surface},1) 60%,${t.soft} 100%)">
    ${info.logo ? `<img src="${esc(info.logo)}" alt="" style="height:46px;max-width:110px;object-fit:contain">` : ''}
    <div style="flex:1;min-width:0"><div style="font-family:var(--display);color:${t.accent};font-size:12px;letter-spacing:.14em;text-transform:uppercase">Special Event</div>
      <div style="font-family:var(--display);font-size:22px;font-weight:700;color:#fff">${esc(ev.name)}</div>
      <div class="dim" style="font-size:12px">${started ? 'läuft — Tippspiel & Tabelle' : ev.replay ? 'Wiederholung startet ' + esc(new Date(ev.replay.from).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })) + ' Uhr' : 'ab ' + esc(new Date(info.start).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })) + ' · jetzt Spiele tippen'}</div></div>
    <span class="btn sm" style="border-color:${t.accent};color:${t.accent}">Öffnen →</span></a>`;
}

function bindEvent() {
  const p = path(), m = p.match(/^\/event\/([\w-]+)$/);
  if (!m) return;
  const slug = m[1];
  document.querySelectorAll('[data-evtab]').forEach(b => b.onclick = () => { EVX.tab = b.dataset.evtab; render(); });
  document.querySelectorAll('[data-evjump]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { const r = await app.adminApi('POST', '/api/admin/test', { action: 'jump', slug, to: b.dataset.evjump }); toast(esc(r.message)); await app.refresh(); }
    catch (e) { toast(`<span style="color:#ffb1b3">${esc(e.message)}</span>`); b.disabled = false; }
  });
  document.querySelectorAll('[data-tip]').forEach(b => b.onclick = async () => {
    const match = b.dataset.tip, cur = (EVX.mt[slug] || (EVX.mt[slug] = Object.assign({}, (EVX.mine[slug] || {}).matchTips || {})))[match];
    const score = cur === b.dataset.sc ? null : b.dataset.sc;
    if (score === null) delete EVX.mt[slug][match]; else EVX.mt[slug][match] = score;
    render();
    try { await api('/api/event/tip', { method: 'POST', body: { slug, match, score } }); }
    catch (e) { if (cur) EVX.mt[slug][match] = cur; else delete EVX.mt[slug][match]; render(); toast(`<span style="color:#ffb1b3">${esc(e.message)}</span>`); }
  });
  document.querySelectorAll('[data-bgcard]').forEach(r => r.onclick = () => { EVX.bingoCard = r.dataset.bgcard; render(); });
  document.querySelectorAll('[data-lvm]').forEach(b => b.onclick = () => { LV.match = b.dataset.lvm; LV.pinned = true; render(); });
  document.querySelectorAll('[data-lvg]').forEach(b => b.onclick = () => { LV.sel[b.dataset.lvmatch] = b.dataset.lvg; LV.selUser[b.dataset.lvmatch] = true; render(); });
  document.querySelectorAll('[data-tipopen]').forEach(r => r.onclick = () => { EVX.openMatch = EVX.openMatch === r.dataset.tipopen ? null : r.dataset.tipopen; render(); });
  const mp = $('monoPilotSave'); if (mp) mp.onclick = async () => {
    try { await api('/api/event/mono', { method: 'POST', body: { slug, pilot: $('monoPilot').value } }); toast('Pilot gesetzt — gilt ab dem nächsten Spiel.'); await app.refresh(); } catch (e) { toast(`<span style="color:#ffb1b3">${esc(e.message)}</span>`); }
  };
  document.querySelectorAll('[data-monorule]').forEach(b => b.onclick = async () => {
    try { await api('/api/event/mono', { method: 'POST', body: { slug, rule: b.dataset.monorule } }); toast('Kauf-Regel gespeichert.'); await app.refresh(); } catch (e) { toast(`<span style="color:#ffb1b3">${esc(e.message)}</span>`); }
  });
  const bs = $('bgShuffle'); if (bs) bs.onclick = async () => {
    try { await app.adminApi('POST', '/api/admin/event', { action: 'update', slug, reshuffle: true }); toast('Neue Bingo-Karte'); await app.refresh(); } catch (e) { toast(esc(e.message)); }
  };
  document.querySelectorAll('[data-evrole]').forEach(b => b.onclick = e => { if (e.target.closest('button[data-evcap],button[data-evdrop]')) return; EVX.role = b.dataset.evrole; render(); });
  document.querySelectorAll('[data-evpick]').forEach(b => b.onclick = () => { const pl = evP(slug, b.dataset.evpick), f = EVX.form[slug]; f.players[pl.role] = pl.id; if (!f.captain || !Object.values(f.players).includes(f.captain)) f.captain = pl.id; const nxt = EV_ROLES.find(r => !f.players[r]); if (nxt) EVX.role = nxt; render(); });
  document.querySelectorAll('[data-evdrop]').forEach(b => b.onclick = () => { const f = EVX.form[slug]; if (f.captain === f.players[b.dataset.evdrop]) f.captain = ''; delete f.players[b.dataset.evdrop]; EVX.role = b.dataset.evdrop; render(); });
  document.querySelectorAll('[data-evcap]').forEach(b => b.onclick = () => { EVX.form[slug].captain = b.dataset.evcap; render(); });
  document.querySelectorAll('[data-evopen]').forEach(b => b.onclick = () => { EVX.open = EVX.open === b.dataset.evopen ? null : b.dataset.evopen; render(); });
  const tipsOf = r => { EVX.tips[slug] = EVX.tips[slug] || {}; return EVX.tips[slug][r] || (EVX.tips[slug][r] = {}); };
  document.querySelectorAll('select[data-evq],input[data-evq]').forEach(el => el.onchange = () => { tipsOf(el.dataset.evr)[el.dataset.evq] = el.value; });
  document.querySelectorAll('.evmulti').forEach(box => box.querySelectorAll('.evchip').forEach(b => b.onclick = () => {
    const tips = tipsOf(box.dataset.evr), max = +box.dataset.max;
    const on = String(tips[box.dataset.evq] || '').split(',').filter(Boolean);
    const i = on.indexOf(b.dataset.code);
    if (i >= 0) on.splice(i, 1); else if (on.length < max) on.push(b.dataset.code); else return toast(`Höchstens ${max} — erst eins abwählen.`);
    tips[box.dataset.evq] = on.join(',');
    b.classList.toggle('on', i < 0);
    const c = box.parentElement.querySelector('.evcount'); if (c) c.textContent = on.length;
  }));
  const q = $('evQ'); if (q) q.oninput = e => { EVX.q = e.target.value; render(); };
  const tf = $('evTeamF'); if (tf) tf.onchange = e => { EVX.team = e.target.value; render(); };
  const sv = $('evSave'); if (sv) sv.onclick = async () => {
    const f = EVX.form[slug];
    try { await api('/api/event/team', { method: 'POST', body: { slug, players: EV_ROLES.map(r => f.players[r]), captain: f.captain } }); toast('Team gespeichert ✓'); await loadMine(slug); }
    catch (e) { toast(`<span style="color:#ffb1b3">${esc(e.message)}</span>`); }
  };
  document.querySelectorAll('[data-evtipsave]').forEach(b => b.onclick = async () => {
    const round = b.dataset.evtipsave;
    try { await api('/api/event/pickem', { method: 'POST', body: { slug, round, picks: tipsOf(round) } }); toast('Tipps gespeichert ✓'); } catch (e) { toast(`<span style="color:#ffb1b3">${esc(e.message)}</span>`); }
  });
  // Switching the video back on resumes it - it does NOT replay the intro.
  // (That was the old behaviour: entered=false put the welcome gate back up.)
  const vb = $('evVid'); if (vb) vb.onclick = () => {
    setVideoOff(slug, false);
    EVX.entered[slug] = true; markIntroSeen(slug);
    EVX.tab = VIDEO_TAB;              // the video lives on this tab
    render();
    // the click itself is the gesture browsers want for sound
    setTimeout(() => playNow(), 60);
  };
}

return { viewEvent, eventRouteHook, bindEvent, eventBanner, currentEventSlug, evInfo, evShort };
};
