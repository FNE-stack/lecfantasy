// ═══════════════════════════════════════════════════════════════════════════
// preview.js — look at ANY stage of the league without being in it.
//
// This is NOT the test mode. Test mode changes the real league (adds bots,
// takes a backup, writes to KV) and has to be cleaned up afterwards. Preview
// touches nothing: it swaps the in-memory league for a synthesized one, the
// normal pages render it, and leaving preview restores the real data. Nothing
// is ever sent to the Worker while preview is on - every write is blocked.
//
// Use it to answer "what will the draft page look like when it is running?" or
// "how does the table read once a split is finished?" before any of it is true.
// ═══════════════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  const SCENARIOS = [
    { id: 'lobby',        name: 'Anmeldung',          hint: 'Liga offen, noch kein Draft' },
    { id: 'draft_soon',   name: 'Draft gleich',       hint: 'Termin steht, Countdown läuft' },
    { id: 'draft_live',   name: 'Draft läuft',        hint: 'mitten im Snake-Draft, du bist dran' },
    { id: 'draft_done',   name: 'Draft fertig',       hint: 'Kader stehen, noch keine Spiele' },
    { id: 'season_early', name: 'Saison, 1 Woche',    hint: 'erste Punkte, Tabelle entsteht' },
    { id: 'season_mid',   name: 'Saison, Mitte',      hint: 'volle Tabelle, Transferfenster' },
    { id: 'season_done',  name: 'Split beendet',      hint: 'Endstand, Hall of Fame' },
    { id: 'event_open',   name: 'Event offen',        hint: 'Team bauen, Pick’em offen' },
    { id: 'event_live',   name: 'Event läuft',        hint: 'Stage gesperrt, Punkte kommen' },
    { id: 'event_done',   name: 'Event beendet',      hint: 'Endstand + Bingo gewertet' },
  ];

  const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
  const NAMES = ['Fabi', 'Timo', 'Jonas', 'Niklas', 'Lukas', 'Marco'];

  let active = null;        // { id, league, note }
  let realLeague = null;

  const clone = o => JSON.parse(JSON.stringify(o));

  // deterministic pseudo-random so a preview looks the same every time
  function rng(seed) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
  }

  function fakeManagers(n, rnd) {
    return NAMES.slice(0, n).map((nm, i) => ({
      id: 'pv' + i, name: nm, joined: new Date(Date.now() - (30 - i) * 864e5).toISOString(),
    }));
  }

  // Build a league object for a scenario, starting from the real one so the
  // scoring rules, roster size and event config stay exactly as configured.
  function build(id, base, players) {
    const rnd = rng(id);
    const lg = clone(base);
    lg.__preview = id;
    const pool = (players && players.players) || [];
    const mgrs = fakeManagers(4, rnd);
    const slots = (lg.roster && lg.roster.slots) || ROLES;
    const perRole = (lg.roster && lg.roster.perRole) || 1;
    const bench = (lg.roster && lg.roster.bench) || 0;
    const perMgr = slots.length * perRole + bench;

    const byRole = {};
    for (const r of ROLES) byRole[r] = pool.filter(p => p.role === r);
    const pick = (role, used) => {
      const list = byRole[role] || [];
      for (let i = 0; i < list.length; i++) {
        const p = list[Math.floor(rnd() * list.length)];
        if (p && !used.has(p.id)) { used.add(p.id); return p.id; }
      }
      const free = list.find(p => !used.has(p.id));
      if (free) { used.add(free.id); return free.id; }
      return null;
    };

    const fullDraft = () => {
      const used = new Set(), picks = [];
      for (let r = 0; r < perMgr; r++) {
        const order = r % 2 ? mgrs.slice().reverse() : mgrs;
        for (const m of order) {
          const role = slots[r % slots.length] || ROLES[r % ROLES.length];
          const pid = pick(role, used);
          if (pid) picks.push({ manager: m.id, player: pid, at: Date.now() - (perMgr - r) * 36e5 });
        }
      }
      return picks;
    };

    lg.managers = mgrs;
    lg.draft = Object.assign({}, lg.draft, { order: mgrs.map(m => m.id), snake: true, picks: [], completed: false });

    switch (id) {
      case 'lobby':
        lg.managers = mgrs.slice(0, 2);
        lg.draft.order = lg.managers.map(m => m.id);
        lg.draft.status = 'lobby';
        break;
      case 'draft_soon':
        lg.draft.status = 'lobby';
        lg.draft.scheduledAt = new Date(Date.now() + 12 * 60000).toISOString();
        break;
      case 'draft_live': {
        lg.draft.status = 'live';
        const all = fullDraft();
        lg.draft.picks = all.slice(0, Math.max(1, Math.floor(all.length * 0.4)));
        lg.draft.pickDeadline = new Date(Date.now() + 63000).toISOString();
        break;
      }
      case 'draft_done':
        lg.draft.status = 'done'; lg.draft.completed = true; lg.draft.picks = fullDraft();
        break;
      case 'season_early':
      case 'season_mid':
      case 'season_done':
        lg.draft.status = 'done'; lg.draft.completed = true; lg.draft.picks = fullDraft();
        lg.__previewWeeks = id === 'season_early' ? 1 : id === 'season_mid' ? 5 : 9;
        lg.__previewDone = id === 'season_done';
        break;
      case 'event_open':
      case 'event_live':
      case 'event_done':
        lg.draft.status = 'done'; lg.draft.completed = true; lg.draft.picks = fullDraft();
        lg.__previewEvent = id;
        break;
    }
    return lg;
  }

  function scenarioOf(id) { return SCENARIOS.find(s => s.id === id) || null; }

  function on(id, base, players) {
    if (!scenarioOf(id)) return false;
    if (!active) realLeague = base;
    active = { id, league: build(id, realLeague || base, players) };
    banner();
    return true;
  }
  function off() {
    active = null;
    const b = document.getElementById('pvbar'); if (b) b.remove();
    document.body.classList.remove('pv-on');
  }
  const isOn = () => !!active;
  const league = () => active && active.league;

  // The preview must never reach the server. Anything that would write is
  // swallowed with a toast instead - that is what makes this safe to click
  // through, unlike the test mode.
  function guard(fn) {
    return function () {
      if (active) {
        if (global.toast) global.toast('Vorschau: Änderungen sind hier aus.');
        return Promise.resolve({ ok: true, preview: true });
      }
      return fn.apply(this, arguments);
    };
  }

  function banner() {
    document.body.classList.add('pv-on');
    let b = document.getElementById('pvbar');
    if (!b) { b = document.createElement('div'); b.id = 'pvbar'; b.className = 'pvbar'; document.body.appendChild(b); }
    const sc = scenarioOf(active.id);
    b.innerHTML = `<b>Vorschau</b><span class="pv-name">${sc.name}</span>
      <span class="pv-hint">${sc.hint}</span>
      <select id="pvSel">${SCENARIOS.map(s => `<option value="${s.id}"${s.id === active.id ? ' selected' : ''}>${s.name}</option>`).join('')}</select>
      <button class="btn sm" id="pvOff">beenden</button>`;
    b.querySelector('#pvSel').onchange = e => { global.LECPreview.switchTo(e.target.value); };
    b.querySelector('#pvOff').onclick = () => { global.LECPreview.stop(); };
  }

  global.LECPreview = {
    SCENARIOS, on, off, isOn, league, guard, scenarioOf,
    // wired by app.js
    switchTo: id => { if (global.__pvSwitch) global.__pvSwitch(id); },
    stop: () => { if (global.__pvStop) global.__pvStop(); },
  };
})(typeof window !== 'undefined' ? window : this);
