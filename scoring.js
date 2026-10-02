// ═══════════════════════════════════════════════════════════════════════════
// scoring.js — the single source of truth for every rule and every number.
//
// Loaded by the site, the admin page AND the Cloudflare Worker, so a score or
// a legality decision can never differ between what someone sees and what the
// server enforces. Pure functions, no DOM, no fetch — everything is passed in.
// ═══════════════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  const r2 = n => Math.round(n * 100) / 100;

  // ── points ──────────────────────────────────────────────────────────────
  // Points for one player-game. `s` = league.scoring.
  function gamePoints(g, s) {
    if (!g) return 0;
    let p = 0;
    p += (g.k || 0) * s.kill;
    p += (g.d || 0) * s.death;
    p += (g.a || 0) * s.assist;
    p += (g.cs || 0) * (s.cs10 || 0);
    if (g.win) p += s.win;
    // bonus like Riot's Fantasy LCS: +points for a big game (10+ kills OR assists)
    const b = s.bonus;
    if (b && b.enabled && ((g.k || 0) >= b.threshold || (g.a || 0) >= b.threshold)) p += b.points;
    return r2(p);
  }

  function byPlayer(games) {
    const m = new Map();
    for (const g of games || []) {
      if (!g.player) continue;
      if (!m.has(g.player)) m.set(g.player, []);
      m.get(g.player).push(g);
    }
    return m;
  }

  function playerTotal(games, s) {
    let t = 0;
    for (const g of games || []) t += gamePoints(g, s);
    return r2(t);
  }

  // Admin stat corrections, applied on top of the fetched rows. Kept as a
  // separate list (data/overrides.json) so a re-fetch never erases them.
  //   {op:'set', game, player, fields:{k,d,a,cs,win,...}}   correct one row
  //   {op:'exclude', game}                                  drop a whole game
  //   {op:'exclude', game, player}                          drop one row
  //   {op:'add', row:{game,player,team,k,d,a,cs,win,ts,...}} add a missing row
  function applyOverrides(games, overrides) {
    const list = (overrides && overrides.rows) || [];
    if (!list.length) return games || [];
    let out = (games || []).map(g => Object.assign({}, g));
    for (const o of list) {
      if (!o || !o.op) continue;
      if (o.op === 'exclude') {
        out = out.filter(g => !(g.game === o.game && (!o.player || g.player === o.player)));
      } else if (o.op === 'set') {
        for (const g of out) {
          if (g.game === o.game && g.player === o.player) Object.assign(g, o.fields || {}, { corrected: true });
        }
      } else if (o.op === 'add' && o.row && o.row.game && o.row.player) {
        out = out.filter(g => !(g.game === o.row.game && g.player === o.row.player));
        out.push(Object.assign({ corrected: true }, o.row));
      }
    }
    return out;
  }

  // ── draft lifecycle ─────────────────────────────────────────────────────
  // lobby: people join, no picks · live: picking · done: rosters fixed.
  // Older files without `status` count as live until completed.
  function draftStatus(league) {
    const d = league.draft || {};
    if (d.completed) return 'done';
    if (d.status === 'lobby' || d.status === 'live' || d.status === 'done') return d.status;
    return 'live';
  }

  function rosterSize(league) {
    return ((league.roster && league.roster.slots) || []).length + ((league.roster && league.roster.bench) || 0);
  }

  // How many managers the player pool supports. Not floor(pool / roster): at
  // that size every player is needed and drafts dead-end (simulated on the
  // 2026 pool: 97% stuck at 10 managers, 20% at 9, 0.9% at 8, 0% at 7).
  // So at most 80% of the pool may be drafted, and every starting role keeps
  // at least one spare. pickError's relax levels cover the rest.
  function capacity(league, playerIndex) {
    const slots = (league.roster && league.roster.slots) || [];
    const size = rosterSize(league) || 1;
    const all = [...playerIndex.values()];
    let cap = Math.floor(all.length * 0.8 / size);
    for (const role of slots) cap = Math.min(cap, all.filter(p => p.role === role).length - 1);
    return Math.max(0, cap);
  }

  // ── ownership over time ─────────────────────────────────────────────────
  // Draft picks count from the start of the season. Swaps and accepted trades
  // apply from their timestamp onward, so a traded player's earlier points stay
  // with his old manager. Entries without a timestamp apply retroactively
  // (that is how older swaps behaved).
  function rosterEvents(league) {
    const ev = [];
    for (const sw of league.swaps || []) {
      if (!sw || !sw.manager || !sw.out || !sw.in) continue;
      ev.push({ at: sw.at || '', moves: [
        { player: sw.out, from: sw.manager, to: null },
        { player: sw.in, from: null, to: sw.manager }] });
    }
    for (const t of league.trades || []) {
      if (!t || t.status !== 'accepted') continue;
      ev.push({ at: t.decidedAt || t.at || '', moves: []
        .concat((t.give || []).map(p => ({ player: p, from: t.from, to: t.to })))
        .concat((t.get || []).map(p => ({ player: p, from: t.to, to: t.from }))) });
    }
    return ev.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  }

  // Who owns whom at time `at` (ISO string); omit `at` for "now".
  function ownership(league, at) {
    const own = new Map();
    for (const p of (league.draft && league.draft.picks) || []) {
      if (p && p.player && p.manager) own.set(p.player, p.manager);
    }
    for (const e of rosterEvents(league)) {
      if (at !== undefined && e.at && e.at > at) break;
      // only apply a move set that is still consistent with current ownership
      const ok = e.moves.every(m => m.from === null ? !own.has(m.player) : own.get(m.player) === m.from);
      if (!ok) continue;
      for (const m of e.moves) if (m.from !== null) own.delete(m.player);
      for (const m of e.moves) if (m.to !== null) own.set(m.player, m.to);
    }
    return own;
  }

  function rosters(league) {
    const own = ownership(league);
    const out = {};
    for (const m of league.managers || []) out[m.id] = [];
    own.forEach(function (mgr, player) { (out[mgr] = out[mgr] || []).push(player); });
    return out;
  }

  // Owner lookup for a game timestamp, computing each ownership segment once.
  function ownerResolver(league) {
    const times = [...new Set(rosterEvents(league).map(e => e.at).filter(Boolean))].sort();
    const seg = [ownership(league, '')];
    for (const t of times) seg.push(ownership(league, t));
    return function (player, ts) {
      let i = 0;
      while (i < times.length && times[i] <= (ts || '')) i++;
      return seg[i].get(player) || null;
    };
  }

  // ── standings ───────────────────────────────────────────────────────────
  // [{manager, name, total, adjust, perPlayer:[{player,team,role,games,pts,current}]}]
  function standings(league, stats, playerIndex) {
    const s = league.scoring;
    const ownerAt = ownerResolver(league);
    const ros = rosters(league);
    const acc = {};
    for (const m of league.managers || []) acc[m.id] = new Map();
    for (const g of (stats && stats.games) || []) {
      const mgr = ownerAt(g.player, g.ts);
      if (!mgr || !acc[mgr]) continue;
      const cur = acc[mgr].get(g.player) || { pts: 0, games: 0 };
      cur.pts += gamePoints(g, s); cur.games++;
      acc[mgr].set(g.player, cur);
    }
    const adj = {};
    for (const a of league.adjustments || []) {
      if (a && a.manager && typeof a.pts === 'number') adj[a.manager] = (adj[a.manager] || 0) + a.pts;
    }
    const rows = (league.managers || []).map(function (m) {
      const ids = new Set([...(ros[m.id] || []), ...acc[m.id].keys()]);
      const perPlayer = [...ids].map(function (pid) {
        const v = acc[m.id].get(pid) || { pts: 0, games: 0 };
        const meta = playerIndex ? playerIndex.get(pid) : null;
        return { player: pid, team: meta ? meta.team : '', role: meta ? meta.role : '',
                 games: v.games, pts: r2(v.pts), current: (ros[m.id] || []).includes(pid) };
      }).sort(function (a, b) { return b.pts - a.pts; });
      const playerSum = perPlayer.reduce(function (t, r) { return t + r.pts; }, 0);
      return { manager: m.id, name: m.name, adjust: r2(adj[m.id] || 0),
               total: r2(playerSum + (adj[m.id] || 0)), perPlayer: perPlayer };
    });
    rows.sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); });
    return rows;
  }

  // Points per manager per block ("Week 3"): { managerId: { block: pts } }.
  // `weekOf` maps match id -> block name.
  function weeklyPoints(league, stats, weekOf) {
    const s = league.scoring, ownerAt = ownerResolver(league), out = {};
    for (const m of league.managers || []) out[m.id] = {};
    for (const g of (stats && stats.games) || []) {
      const mgr = ownerAt(g.player, g.ts), b = weekOf.get ? weekOf.get(g.match) : weekOf[g.match];
      if (!mgr || !b || !out[mgr]) continue;
      out[mgr][b] = r2((out[mgr][b] || 0) + gamePoints(g, s));
    }
    return out;
  }

  // ── head to head ────────────────────────────────────────────────────────
  // Round robin by the circle method: everyone meets everyone once per cycle,
  // the cycle repeats. Odd numbers get a bye (null opponent).
  function h2hPairs(ids, roundIdx) {
    const a = ids.slice();
    if (a.length < 2) return [];
    if (a.length % 2) a.push(null);
    const n = a.length, r = roundIdx % (n - 1);
    const rest = a.slice(1);
    const rot = rest.slice(rest.length - r).concat(rest.slice(0, rest.length - r));
    const seq = [a[0]].concat(rot);
    const pairs = [];
    for (let i = 0; i < n / 2; i++) pairs.push([seq[i], seq[n - 1 - i]]);
    return pairs;
  }

  // {table:[{manager,name,w,l,t,pf,pa}], weeks:[{block, games:[{a,b,pa,pb}]}]}
  // Only blocks that have been played count. Order of managers = join order.
  function h2h(league, stats, weekOf, blocks) {
    const ids = (league.managers || []).map(m => m.id);
    const wk = weeklyPoints(league, stats, weekOf);
    const played = new Set();
    for (const g of (stats && stats.games) || []) {
      const b = weekOf.get ? weekOf.get(g.match) : weekOf[g.match];
      if (b) played.add(b);
    }
    const row = {};
    for (const m of league.managers || []) row[m.id] = { manager: m.id, name: m.name, w: 0, l: 0, t: 0, pf: 0, pa: 0 };
    const weeks = [];
    (blocks || []).forEach(function (b, i) {
      const games = h2hPairs(ids, i).map(function ([x, y]) {
        const px = x ? (wk[x] || {})[b] || 0 : null, py = y ? (wk[y] || {})[b] || 0 : null;
        return { a: x, b: y, pa: px, pb: py };
      });
      const done = played.has(b);
      if (done) {
        for (const g of games) {
          if (!g.a || !g.b) continue;
          const A = row[g.a], B = row[g.b];
          A.pf += g.pa; A.pa += g.pb; B.pf += g.pb; B.pa += g.pa;
          if (g.pa > g.pb) { A.w++; B.l++; } else if (g.pb > g.pa) { B.w++; A.l++; } else { A.t++; B.t++; }
        }
      }
      weeks.push({ block: b, played: done, games: games });
    });
    const table = Object.values(row).map(r => Object.assign(r, { pf: r2(r.pf), pa: r2(r.pa) }))
      .sort((a, b) => (b.w + b.t / 2) - (a.w + a.t / 2) || b.pf - a.pf);
    return { table: table, weeks: weeks };
  }

  // ── draft rules ─────────────────────────────────────────────────────────
  // A draft must never get stuck. If the manager on the clock has no pick that
  // passes every rule, the rules relax for that one pick:
  //   level 0  all rules
  //   level 1  ignore the per-team limit
  //   level 2  anything still free
  // The admin consistency check flags such picks as warnings.
  function relaxLevel(league, playerIndex, managerId) {
    const free = [...playerIndex.keys()];
    for (const level of [0, 1]) {
      if (free.some(pid => !pickError(league, playerIndex, managerId, pid, level))) return level;
    }
    return 2;
  }

  // Returns null if legal, or a human-readable reason. Pass `level` when
  // checking many players in a row (relaxLevel once, then reuse it).
  function pickError(league, playerIndex, managerId, playerId, level) {
    const own = ownership(league);
    if (own.has(playerId)) {
      const who = own.get(playerId);
      const m = (league.managers || []).find(x => x.id === who);
      return 'schon gedraftet von ' + (m ? m.name : who);
    }
    const meta = playerIndex.get(playerId);
    if (!meta) return 'unbekannter Spieler';
    if (level === undefined) level = relaxLevel(league, playerIndex, managerId);

    const mine = [];
    own.forEach(function (mgr, pid) { if (mgr === managerId) mine.push(pid); });

    const slots = league.roster.slots || [];
    const bench = league.roster.bench || 0;
    if (mine.length >= slots.length + bench) return 'Kader voll';
    if (level >= 2) return null;

    const roleCount = {};
    for (const pid of mine) {
      const mm = playerIndex.get(pid);
      if (mm) roleCount[mm.role] = (roleCount[mm.role] || 0) + 1;
    }
    const need = slots.filter(r => !roleCount[r]);
    if (need.length) {
      const remaining = slots.length + bench - mine.length;
      if ((roleCount[meta.role] || 0) >= 1 && remaining <= need.length) {
        return 'brauchst noch: ' + need.join(', ');
      }
    }

    if (level >= 1) return null;
    const maxTeam = league.roster.maxPerTeam || 99;
    let sameTeam = 0;
    for (const pid of mine) {
      const mm = playerIndex.get(pid);
      if (mm && mm.team === meta.team) sameTeam++;
    }
    if (sameTeam >= maxTeam) return 'max. ' + maxTeam + ' von ' + meta.team;
    return null;
  }

  // Whose turn is it? Snake order over the draft order. Nobody, unless live.
  function currentPicker(league) {
    if (draftStatus(league) !== 'live') return null;
    const order = (league.draft && league.draft.order) || [];
    if (!order.length) return null;
    const n = ((league.draft && league.draft.picks) || []).length;
    const totalPicks = order.length * rosterSize(league);
    if (n >= totalPicks) return null;
    const round = Math.floor(n / order.length);
    const idx = n % order.length;
    const snake = league.draft.snake && (round % 2 === 1);
    return order[snake ? order.length - 1 - idx : idx];
  }

  function draftProgress(league) {
    const order = (league.draft && league.draft.order) || [];
    const total = order.length * rosterSize(league);
    const done = ((league.draft && league.draft.picks) || []).length;
    return { done: done, total: total, round: Math.floor(done / Math.max(1, order.length)) + 1 };
  }

  // ── transfers: trades + free-agent pickups ──────────────────────────────
  // league.tradeRules = {
  //   enabled        trades between managers
  //   freeAgents     pick up players nobody drafted
  //   perWeek        free-agent pickups per manager per calendar week (0 = no limit)
  //   adminApproval  admin must confirm trades the two managers agreed on
  //   equalCount     same number of players on both sides
  //   rosterRules    after a transfer every starting role stays covered
  //   teamLimit      after a transfer nobody is over roster.maxPerTeam
  //   mode           'windows' = only inside windows[] (the LEC transfer
  //                  periods the admin enters) · 'always'
  //   windows        [{from, to, label}] ISO dates, inclusive
  // }
  function transferRules(league) {
    return Object.assign({ enabled: false, freeAgents: false, perWeek: 1, adminApproval: false,
      equalCount: true, rosterRules: true, teamLimit: true, mode: 'windows', windows: [], faMode: 'instant' }, league.tradeRules || {});
  }

  // {open, current, next} at time `now` (ISO). No window entered = closed.
  function transferWindow(league, now) {
    const r = transferRules(league);
    const t = now || new Date().toISOString();
    if (r.mode === 'always') return { open: true, current: null, next: null };
    const ws = (r.windows || []).filter(w => w && w.from && w.to).slice()
      .sort((a, b) => a.from.localeCompare(b.from));
    const current = ws.find(w => w.from <= t && t <= w.to) || null;
    const next = ws.find(w => w.from > t) || null;
    return { open: !!current, current, next };
  }

  // Problems a roster would have (empty list = fine). Used for transfers:
  // every starting role covered, nobody over the per-team limit.
  // opts: { roles: true, teams: true } - which of the two checks to run
  function rosterProblems(league, playerIndex, ids, opts) {
    opts = Object.assign({ roles: true, teams: true }, opts || {});
    const out = [], roles = {}, teams = {};
    for (const id of ids) {
      const p = playerIndex.get(id);
      if (!p) continue;
      roles[p.role] = (roles[p.role] || 0) + 1;
      teams[p.team] = (teams[p.team] || 0) + 1;
    }
    if (opts.roles) for (const r of (league.roster && league.roster.slots) || []) if (!roles[r]) out.push('keine ' + r + ' mehr');
    const max = (league.roster && league.roster.maxPerTeam) || 99;
    if (opts.teams) for (const [t, n] of Object.entries(teams)) if (n > max) out.push(n + ' von ' + t + ' (max. ' + max + ')');
    return out;
  }

  // ── waivers ────────────────────────────────────────────────────────────
  // tradeRules.faMode: 'instant' (first click wins) | 'waiver' (claims are
  // collected and resolved at scheduled times). tradeRules.waiver:
  //   days   [1..7] Mon..Sun, German time     time 'HH:MM' German time
  //   order  'reverse' = lowest total points picks first (recomputed each run)
  //          'rolling' = whoever gets a player moves to the back
  // Times are Europe/Berlin because that is where the league lives; the
  // Worker runs on UTC, so convert explicitly (DST included).
  const TZ = 'Europe/Berlin';
  function berlinParts(ms) {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
    const o = {};
    for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
    const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[o.weekday];
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, wd };
  }
  // UTC ms for a German wall-clock time on the date of `ms` (in Berlin)
  function berlinAt(ms, hh, mm) {
    const p = berlinParts(ms);
    let guess = Date.UTC(p.y, p.mo - 1, p.d, hh, mm);
    for (let i = 0; i < 3; i++) {   // correct for the Berlin offset (1 or 2 h)
      const q = berlinParts(guess);
      const diff = ((q.h * 60 + q.mi) - (hh * 60 + mm)) + (q.d !== p.d ? (q.d > p.d || q.mo > p.mo ? 1440 : -1440) : 0);
      if (!diff) break;
      guess -= diff * 60000;
    }
    return guess;
  }
  function waiverRules(league) {
    const r = transferRules(league);
    return Object.assign({ days: [2, 5], time: '03:00', order: 'reverse' }, r.waiver || {});
  }
  // scheduled run times within [fromMs, toMs], ascending
  function waiverSlots(league, fromMs, toMs) {
    const w = waiverRules(league);
    const [hh, mm] = String(w.time || '03:00').split(':').map(Number);
    const out = [];
    for (let day = fromMs - 864e5; day <= toMs + 864e5 && out.length < 400; day += 864e5) {
      const t = berlinAt(day, hh, mm);
      if (t >= fromMs && t <= toMs && (w.days || []).includes(berlinParts(t).wd) && !out.includes(t)) out.push(t);
    }
    return out.sort((a, b) => a - b);
  }
  function nextWaiverRun(league, nowMs) {
    const now = nowMs || Date.now();
    return waiverSlots(league, now + 1, now + 8 * 864e5)[0] || null;
  }
  function lastWaiverSlot(league, nowMs) {
    const now = nowMs || Date.now();
    const s = waiverSlots(league, now - 8 * 864e5, now);
    return s.length ? s[s.length - 1] : null;
  }
  // priority, first = picks first. 'reverse': lowest standing first (ties:
  // reverse draft order); 'rolling': league.waiverOrder, new members appended.
  function waiverOrder(league, stats, playerIndex) {
    const ids = (league.managers || []).map(m => m.id);
    const draftOrder = ((league.draft && league.draft.order) || ids).slice().reverse();
    if (waiverRules(league).order === 'rolling') {
      const base = (league.waiverOrder || []).filter(id => ids.includes(id));
      return base.concat(draftOrder.filter(id => !base.includes(id))).concat(ids.filter(id => !base.includes(id) && !draftOrder.includes(id)));
    }
    const tot = {};
    for (const r of standings(league, stats || { games: [] }, playerIndex)) tot[r.manager] = r.total;
    return ids.slice().sort((a, b) => (tot[a] || 0) - (tot[b] || 0) || draftOrder.indexOf(a) - draftOrder.indexOf(b));
  }

  // Monday 00:00 UTC of the week `iso` falls in - the key for perWeek.
  function weekKey(iso) {
    const d = new Date(iso);
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day); d.setUTCHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  }

  // ── consistency check (admin) ───────────────────────────────────────────
  // errors: the file is broken, writes are refused · warnings: legal but odd
  // (usually the result of an admin override), each with a suggested fix.
  function validateLeague(league, playerIndex) {
    const errors = [], warnings = [];
    const err = (msg, fix) => errors.push({ msg, fix: fix || null });
    const warn = (msg, fix) => warnings.push({ msg, fix: fix || null });
    if (!league || typeof league !== 'object') { err('league.json ist kein Objekt'); return { errors, warnings }; }
    const mgrs = league.managers;
    if (!Array.isArray(mgrs)) err('managers fehlt oder ist keine Liste');
    const ids = new Set();
    for (const m of mgrs || []) {
      if (!m || !m.id || typeof m.id !== 'string') { err('Manager ohne gültige id'); continue; }
      if (ids.has(m.id)) err('Manager-id doppelt: ' + m.id);
      ids.add(m.id);
      if (!m.name) warn('Manager ohne Namen: ' + m.id);
    }
    const sc = league.scoring || {};
    for (const k of ['kill', 'death', 'assist', 'win']) {
      if (typeof sc[k] !== 'number' || !isFinite(sc[k])) err('scoring.' + k + ' ist keine Zahl');
    }
    const ro = league.roster || {};
    if (!Array.isArray(ro.slots) || !ro.slots.length) err('roster.slots fehlt');
    const d = league.draft;
    if (!d || typeof d !== 'object') { err('draft fehlt'); return { errors, warnings }; }
    if (!Array.isArray(d.order)) err('draft.order ist keine Liste');
    if (!Array.isArray(d.picks)) err('draft.picks ist keine Liste');
    if (errors.length) return { errors, warnings };

    for (const id of d.order) if (!ids.has(id)) err('Draft-Reihenfolge enthält unbekannten Manager: ' + id, { op: 'setOrder', order: d.order.filter(x => ids.has(x)) });
    if (new Set(d.order).size !== d.order.length) err('Draft-Reihenfolge enthält Doppelte', { op: 'setOrder', order: [...new Set(d.order)].filter(x => ids.has(x)) });
    const missing = [...ids].filter(id => !d.order.includes(id));
    if (missing.length) warn('Nicht in der Draft-Reihenfolge: ' + missing.join(', '), { op: 'setOrder', order: d.order.filter(x => ids.has(x)).concat(missing) });

    const total = d.order.length * rosterSize(league);
    if (d.picks.length > total) err(`Mehr Picks (${d.picks.length}) als möglich (${total})`);
    const seen = new Map();
    // replay the draft to find picks that broke a rule (admin overrides)
    const sim = JSON.parse(JSON.stringify(league));
    sim.draft.picks = []; sim.draft.completed = false; sim.draft.status = 'live';
    sim.swaps = []; sim.trades = [];
    d.picks.forEach(function (p, i) {
      if (!p || !p.player || !p.manager) { err(`Pick #${i + 1} ist unvollständig`, { op: 'removePick', index: i }); return; }
      if (!ids.has(p.manager)) err(`Pick #${i + 1} gehört unbekanntem Manager ${p.manager}`, { op: 'removePick', index: i });
      if (seen.has(p.player)) err(`Spieler doppelt gepickt (#${seen.get(p.player) + 1} und #${i + 1})`, { op: 'removePick', index: i });
      seen.set(p.player, i);
      if (playerIndex && !playerIndex.has(p.player)) warn(`Pick #${i + 1}: Spieler ${p.player} nicht mehr im Pool`);
      const expect = currentPicker(sim);
      if (expect && expect !== p.manager) warn(`Pick #${i + 1} außer der Reihe (${p.manager} statt ${expect})`);
      if (playerIndex && playerIndex.has(p.player)) {
        const strict = pickError(sim, playerIndex, p.manager, p.player, 0);
        if (strict && !/schon gedraftet/.test(strict)) {
          const lvl = relaxLevel(sim, playerIndex, p.manager);
          warn(lvl > 0 && !pickError(sim, playerIndex, p.manager, p.player, lvl)
            ? `Pick #${i + 1}: Notfall-Regel (kein regulärer Pick mehr möglich) — ${strict}`
            : `Pick #${i + 1} verletzt eine Regel: ${strict}`);
        }
      }
      sim.draft.picks.push(p);
    });
    const st = draftStatus(league);
    if (st === 'done' && d.picks.length < total) warn(`Draft gesperrt, aber erst ${d.picks.length}/${total} Picks`);
    if (st === 'live' && total > 0 && d.picks.length >= total) warn('Alle Picks vergeben, Draft aber nicht gesperrt', { op: 'setStatus', status: 'done' });
    if (st === 'lobby' && d.picks.length) warn('Status Anmeldung, aber es gibt schon Picks', { op: 'setStatus', status: 'live' });
    for (const a of league.adjustments || []) {
      if (!a || !ids.has(a.manager) || typeof a.pts !== 'number') warn('Ungültige Punktekorrektur: ' + JSON.stringify(a));
    }
    return { errors, warnings };
  }

  global.LECScoring = {
    gamePoints, byPlayer, playerTotal, applyOverrides,
    draftStatus, rosterSize, capacity,
    rosterEvents, ownership, rosters, standings, weeklyPoints,
    h2hPairs, h2h,
    pickError, relaxLevel, currentPicker, draftProgress, validateLeague,
    transferRules, transferWindow, rosterProblems, weekKey,
    berlinParts, berlinAt, waiverRules, waiverSlots, nextWaiverRun, lastWaiverSlot, waiverOrder
  };
// `this` is undefined in an ES module, so a Cloudflare Worker importing this
// file would crash on a bare `this`. globalThis works in every place these
// rules run: browser, node test harness, Worker.
})(typeof window !== 'undefined' ? window : globalThis);
