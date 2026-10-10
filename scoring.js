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

  // roster.perRole (e.g. 2): every manager holds exactly that many players per
  // role - with 2 there is always a backup for a benched starter. Without it:
  // one per slot + roster.bench free picks (the older model).
  function rosterSize(league) {
    const r = league.roster || {}, slots = (r.slots || []).length;
    return r.perRole ? slots * r.perRole : slots + (r.bench || 0);
  }

  // How many managers the player pool supports. Not floor(pool / roster): at
  // that size every player is needed and drafts dead-end (simulated on the
  // 2026 pool: 97% stuck at 10 managers, 20% at 9, 0.9% at 8, 0% at 7).
  // So at most 80% of the pool may be drafted, and every role keeps spares.
  // roster.maxManagers lets the admin override it (relax levels keep a draft
  // from ever getting stuck, the admin page warns when it is tight).
  function suggestedCapacity(league, playerIndex) {
    const r = league.roster || {}, slots = r.slots || [];
    const size = rosterSize(league) || 1, per = r.perRole || 1;
    const all = [...playerIndex.values()];
    let cap = Math.floor(all.length * 0.8 / size);
    for (const role of slots) cap = Math.min(cap, Math.floor((all.filter(p => p.role === role).length - 1) / per));
    return Math.max(0, cap);
  }
  function capacity(league, playerIndex) {
    const o = league.roster && league.roster.maxManagers;
    return o ? o : suggestedCapacity(league, playerIndex);
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

  // ── calendar ────────────────────────────────────────────────────────────
  // A "week" is a schedule block within a split: "lec_split_2_2026|Week 3".
  // The split is part of the key because every split has a Week 1.
  function blockKey(e) { return (e.tournament || '') + '|' + (e.block || ''); }
  function calendar(schedule) {
    const blockOf = new Map(), start = new Map(), end = new Map();
    for (const e of (schedule && schedule.events) || []) {
      if (!e.block) continue;
      const k = blockKey(e), t = Date.parse(e.start);
      blockOf.set(e.match, k);
      if (!start.has(k) || t < start.get(k)) start.set(k, t);
      if (!end.has(k) || t > end.get(k)) end.set(k, t);
    }
    const keys = [...start.keys()].sort((a, b) => start.get(a) - start.get(b));
    return { blockOf, start, end, keys, split: k => k.split('|')[0], name: k => k.split('|').slice(1).join('|') };
  }

  // ── lineups ─────────────────────────────────────────────────────────────
  // league.lineup = { enabled, captain: 1.5 }
  // league.lineups[manager][blockKey] = { starters:[ids], bench:[ids], captain, vice }
  // A week's lineup locks when its first match starts. Not set (or no longer
  // valid) -> automatic: per role the player with the best average BEFORE
  // that week, captain/vice = the two best starters. A starter without a game
  // that week is auto-subbed by the bench player of the same role who played
  // (like Fantasy Premier League); a captain without a game passes the bonus
  // to the vice-captain.
  function lineupConfig(league) { return Object.assign({ enabled: false, captain: 1.5 }, league.lineup || {}); }

  // per player: [{t, pts}] sorted by time - for averages before a moment
  function history(stats, s) {
    const h = new Map();
    for (const g of (stats && stats.games) || []) {
      if (!h.has(g.player)) h.set(g.player, []);
      h.get(g.player).push({ t: Date.parse(g.ts), pts: gamePoints(g, s) });
    }
    h.forEach(v => v.sort((a, b) => a.t - b.t));
    return h;
  }
  function avgBefore(hist, id, t) {
    const v = hist.get(id) || [];
    let n = 0, sum = 0;
    for (const x of v) { if (x.t >= t) break; n++; sum += x.pts; }
    return n ? sum / n : -1;
  }

  function lineupFor(league, ctx, managerId, key) {
    const t0 = ctx.cal.start.get(key);
    const roster = [];
    // roster as it stood when the week started (transfers mid-week count from next week)
    ctx.ownAtStart = ctx.ownAtStart || new Map();
    if (!ctx.ownAtStart.has(key)) ctx.ownAtStart.set(key, ownership(league, new Date(t0).toISOString()));
    ctx.ownAtStart.get(key).forEach((m, pid) => { if (m === managerId) roster.push(pid); });
    const slots = (league.roster && league.roster.slots) || [];
    const role = id => (ctx.playerIndex.get(id) || {}).role;
    // Neutral ordering only. The game is the manager's judgement, so nothing
    // here may rank players by form - that would be the system quietly making
    // the decision. Fallbacks keep LAST WEEK'S lineup; where that is
    // impossible (a carried player left the roster) we fill the slot in a
    // stable, opinion-free order so the manager still fields a full five.
    const stable = ids => ids.slice().sort((a, b) => String(a).localeCompare(String(b)));
    // this week's lineup, else the most recent earlier one, carried forward
    // unchanged - missing a week costs you, it does not get auto-optimised.
    const mine = ((league.lineups || {})[managerId]) || {};
    let saved = mine[key];
    let carried = false;
    if (!saved) {
      const earlier = ctx.cal.keys.slice(0, ctx.cal.keys.indexOf(key)).reverse().find(k => mine[k]);
      if (earlier) { saved = mine[earlier]; carried = true; }
    }
    const starters = [];
    let auto = true;
    if (saved && Array.isArray(saved.starters)) {
      auto = false;
      for (const r of slots) {
        const pick = saved.starters.find(id => roster.includes(id) && role(id) === r);
        if (pick) starters.push(pick);
        else { auto = true; const fill = stable(roster.filter(id => role(id) === r))[0]; if (fill) starters.push(fill); }
      }
    } else {
      for (const r of slots) { const fill = stable(roster.filter(id => role(id) === r))[0]; if (fill) starters.push(fill); }
    }
    const benchSaved = saved && Array.isArray(saved.bench) ? saved.bench.filter(id => roster.includes(id) && !starters.includes(id)) : [];
    const bench = benchSaved.concat(stable(roster.filter(id => !starters.includes(id) && !benchSaved.includes(id))));
    const ordered = stable(starters);
    let captain = saved && starters.includes(saved.captain) ? saved.captain : ordered[0];
    let vice = saved && starters.includes(saved.vice) && saved.vice !== captain ? saved.vice : ordered.find(id => id !== captain);
    return { starters, bench, captain, vice, auto, carried, roster };
  }

  // What the lineup for `key` would be right now (for the lineup editor).
  function lineupPreview(league, stats, playerIndex, schedule, managerId, key) {
    const cal = calendar(schedule);
    if (!cal.start.has(key)) return null;
    return lineupFor(league, { cal, hist: history(stats, league.scoring), playerIndex: playerIndex || new Map() }, managerId, key);
  }

  // The one place points are attributed. Returns per manager:
  //   total, byBlock{key:pts}, perPlayer{id:{pts,games,benchPts}}, lineups{key:info}
  function scoreBook(league, stats, playerIndex, schedule) {
    const s = league.scoring;
    const cal = calendar(schedule);
    const ownerAt = ownerResolver(league);
    const hist = history(stats, s);
    const lc = lineupConfig(league);
    const ctx = { cal, ownerAt, hist, playerIndex: playerIndex || new Map() };
    const book = {};
    for (const m of league.managers || []) book[m.id] = { total: 0, byBlock: {}, perPlayer: {}, lineups: {} };
    const add = (m, pid, key, pts, counted) => {
      const b = book[m]; if (!b) return;
      const pp = b.perPlayer[pid] || (b.perPlayer[pid] = { pts: 0, games: 0, benchPts: 0 });
      pp.games++;
      if (counted) { pp.pts += pts; b.total += pts; if (key) b.byBlock[key] = (b.byBlock[key] || 0) + pts; }
      else pp.benchPts += pts;
    };
    // group games by block
    const byBlock = new Map();
    for (const g of (stats && stats.games) || []) {
      const key = cal.blockOf.get(g.match) || null;
      if (!byBlock.has(key)) byBlock.set(key, []);
      byBlock.get(key).push(g);
    }
    byBlock.forEach((games, key) => {
      if (!lc.enabled || !key || !cal.start.has(key)) {
        for (const g of games) { const m = ownerAt(g.player, g.ts); if (m) add(m, g.player, key, gamePoints(g, s), true); }
        return;
      }
      const played = new Set(games.map(g => g.player));
      for (const m of league.managers || []) {
        const lu = lineupFor(league, ctx, m.id, key);
        if (!lu.roster.length) continue;
        // auto-sub: a starter without a game this week -> first bench player of that role who played
        const role = id => (ctx.playerIndex.get(id) || {}).role;
        const active = lu.starters.map(id => played.has(id) ? id : (lu.bench.find(b => role(b) === role(id) && played.has(b)) || id));
        const subs = lu.starters.map((id, i) => active[i] !== id ? { out: id, in: active[i] } : null).filter(Boolean);
        const cap = played.has(lu.captain) && active.includes(lu.captain) ? lu.captain
          : (played.has(lu.vice) && active.includes(lu.vice) ? lu.vice : null);
        book[m.id].lineups[key] = Object.assign({}, lu, { active, subs, captainScored: cap });
        for (const g of games) {
          if (ownerAt(g.player, g.ts) !== m.id) continue;
          let pts = gamePoints(g, s);
          const counted = active.includes(g.player);
          if (counted && g.player === cap) pts = r2(pts * lc.captain);
          add(m.id, g.player, key, pts, counted);
        }
      }
    });
    Object.values(book).forEach(b => { b.total = r2(b.total); Object.keys(b.byBlock).forEach(k => b.byBlock[k] = r2(b.byBlock[k])); });
    book._cal = cal;
    return book;
  }

  // ── standings ───────────────────────────────────────────────────────────
  // [{manager, name, total, players, pickem, adjust, perPlayer:[{player,team,role,games,pts,benchPts,current}], bySplit}]
  // `schedule` drives weeks/lineups; `season` (season.json) lets pick'ems
  // resolve. Both optional: without them every owned player's points count.
  function standings(league, stats, playerIndex, schedule, season, official) {
    const book = scoreBook(league, stats, playerIndex, schedule);
    const ros = rosters(league);
    const adj = {};
    for (const a of league.adjustments || []) if (a && a.manager && typeof a.pts === 'number') adj[a.manager] = (adj[a.manager] || 0) + a.pts;
    const pk = pickemPoints(league, stats, schedule, playerIndex, official);
    const rows = (league.managers || []).map(function (m) {
      const b = book[m.id];
      const ids = new Set([...(ros[m.id] || []), ...Object.keys(b.perPlayer)]);
      const perPlayer = [...ids].map(function (pid) {
        const v = b.perPlayer[pid] || { pts: 0, games: 0, benchPts: 0 };
        const meta = playerIndex ? playerIndex.get(pid) : null;
        return { player: pid, team: meta ? meta.team : '', role: meta ? meta.role : '', games: v.games,
                 pts: r2(v.pts), benchPts: r2(v.benchPts), current: (ros[m.id] || []).includes(pid) };
      }).sort(function (a, b) { return b.pts - a.pts; });
      const bySplit = {};
      Object.entries(b.byBlock).forEach(([k, v]) => { const sp = k.split('|')[0]; bySplit[sp] = r2((bySplit[sp] || 0) + v); });
      const pick = pk[m.id] ? pk[m.id].total : 0;
      return { manager: m.id, name: m.name, players: b.total, pickem: pick, adjust: r2(adj[m.id] || 0),
               total: r2(b.total + pick + (adj[m.id] || 0)), perPlayer, bySplit, byBlock: b.byBlock, lineups: b.lineups };
    });
    rows.sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); });
    return rows;
  }

  // Points per manager per week: { managerId: { blockKey: pts } }
  function weeklyPoints(league, stats, schedule, playerIndex) {
    const book = scoreBook(league, stats, playerIndex, schedule), out = {};
    for (const m of league.managers || []) out[m.id] = book[m.id].byBlock;
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

  // {table:[{manager,name,w,l,t,pf,pa}], weeks:[{block, games:[{a,b,pa,pb}], played}]}
  function h2h(league, stats, schedule, playerIndex) {
    const ids = (league.managers || []).map(m => m.id);
    const book = scoreBook(league, stats, playerIndex, schedule);
    const cal = book._cal;
    const played = new Set();
    for (const g of (stats && stats.games) || []) { const k = cal.blockOf.get(g.match); if (k) played.add(k); }
    const row = {};
    for (const m of league.managers || []) row[m.id] = { manager: m.id, name: m.name, w: 0, l: 0, t: 0, pf: 0, pa: 0 };
    const weeks = cal.keys.map(function (key, i) {
      const games = h2hPairs(ids, i).map(function ([x, y]) {
        return { a: x, b: y, pa: x ? book[x].byBlock[key] || 0 : null, pb: y ? book[y].byBlock[key] || 0 : null };
      });
      const done = played.has(key) && (cal.end.get(key) || 0) < Date.now();
      if (done) for (const g of games) {
        if (!g.a || !g.b) continue;
        const A = row[g.a], B = row[g.b];
        A.pf += g.pa; A.pa += g.pb; B.pf += g.pb; B.pa += g.pa;
        if (g.pa > g.pb) { A.w++; B.l++; } else if (g.pb > g.pa) { B.w++; A.l++; } else { A.t++; B.t++; }
      }
      return { block: key, played: done, games };
    });
    const table = Object.values(row).map(r => Object.assign(r, { pf: r2(r.pf), pa: r2(r.pa) }))
      .sort((a, b) => (b.w + b.t / 2) - (a.w + a.t / 2) || b.pf - a.pf);
    return { table, weeks };
  }

  // ── pick'em (per split) ─────────────────────────────────────────────────
  // league.pickems[split] = { questions:[{id,type,points,label?,answer?}],
  //   lockAt?, revealed, picks:{manager:{qid:value}} }   (picks hidden in the
  // Worker until the lock, then copied here). Resolved automatically from the
  // data once the split is over; 'manual*' types take the admin's answer.
  const PICKEM_TYPES = {
    champion:     { kind: 'team',     label: 'Split-Sieger' },
    finalist:     { kind: 'team',     label: 'Ein Finalist' },
    firstRegular: { kind: 'team',     label: 'Platz 1 nach der Regular Season' },
    lastRegular:  { kind: 'team',     label: 'Letzter Platz nach der Regular Season' },
    mostKills:    { kind: 'player',   label: 'Meiste Kills (Spieler)' },
    mostPoints:   { kind: 'player',   label: 'Meiste Fantasy-Punkte (Spieler)' },
    bestKda:      { kind: 'player',   label: 'Beste KDA (Spieler, mind. halbe Spielzahl)' },
    mostChamps:   { kind: 'player',   label: 'Meiste verschiedene Champions (Spieler)' },
    maxKillsGame: { kind: 'player',   label: 'Meiste Kills in einem Spiel (Spieler)' },
    mostPicked:   { kind: 'champion', label: 'Meistgepickter Champion' },
    longestGame:  { kind: 'number',   label: 'Längstes Spiel (Minuten, wer am nächsten liegt)' },
    bloodiest:    { kind: 'number',   label: 'Meiste Kills in einem Spiel insgesamt (wer am nächsten liegt)' },
    manualChamp:  { kind: 'champion', label: 'Eigene Frage (Champion)', manual: true },
    manualTeam:   { kind: 'team',     label: 'Eigene Frage (Team)', manual: true },
    manualPlayer: { kind: 'player',   label: 'Eigene Frage (Spieler)', manual: true },
  };
  const PLAYOFF = /playoff|final|knockout|bracket|tiebreak/i;

  function splitDone(schedule, split) {
    const ev = ((schedule && schedule.events) || []).filter(e => e.tournament === split);
    return ev.length > 0 && ev.every(e => e.state === 'completed') && Date.parse(ev[ev.length - 1].start) < Date.now();
  }
  function pickemLock(league, schedule, split) {
    const pe = (league.pickems || {})[split] || {};
    if (pe.lockAt) return pe.lockAt;
    const ev = ((schedule && schedule.events) || []).filter(e => e.tournament === split).sort((a, b) => a.start.localeCompare(b.start));
    return ev.length ? ev[0].start : null;
  }

  // the correct answer(s) per question type for one split, or null if unknown
  // `official` (optional): standings.json for the split - its regular-season
  // ranking includes the official tiebreaks, so it wins over our own count
  // pick'em answers that come from the game rows alone (season and events)
  function statTruth(rows, scoring) {
    const out = {};
    if (!rows.length) return out;
    const best = (m, cmp) => { let top = null; const set = new Set(); m.forEach((v, k) => { if (top === null || cmp(v, top) > 0) { top = v; set.clear(); set.add(k); } else if (cmp(v, top) === 0) set.add(k); }); return set; };
    const desc = (a, b) => a - b;
      const kills = new Map(), pts = new Map(), games = new Map(), kd = new Map(), champs = new Map(), picked = new Map(), maxK = new Map();
      const perGame = new Map();
      for (const g of rows) {
        kills.set(g.player, (kills.get(g.player) || 0) + g.k);
        pts.set(g.player, (pts.get(g.player) || 0) + gamePoints(g, scoring));
        games.set(g.player, (games.get(g.player) || 0) + 1);
        const x = kd.get(g.player) || { k: 0, d: 0, a: 0 }; x.k += g.k; x.d += g.d; x.a += g.a; kd.set(g.player, x);
        if (!champs.has(g.player)) champs.set(g.player, new Set()); champs.get(g.player).add(g.champ);
        picked.set(g.champ, (picked.get(g.champ) || 0) + 1);
        maxK.set(g.player, Math.max(maxK.get(g.player) || 0, g.k));
        const pg = perGame.get(g.game) || { k: 0, dur: g.dur || 0 }; pg.k += g.k; perGame.set(g.game, pg);
      }
      const r1 = n => Math.round(n * 100) / 100;
      out.mostKills = best(kills, desc);
      out.mostPoints = best(new Map([...pts].map(([k, v]) => [k, r1(v)])), desc);
      const maxGames = Math.max(...games.values());
      out.bestKda = best(new Map([...kd].filter(([k]) => games.get(k) >= maxGames / 2).map(([k, v]) => [k, r1((v.k + v.a) / Math.max(1, v.d))])), desc);
      out.mostChamps = best(new Map([...champs].map(([k, v]) => [k, v.size])), desc);
      out.maxKillsGame = best(maxK, desc);
      out.mostPicked = best(picked, desc);
      const pgs = [...perGame.values()];
      out.longestGame = Math.round(Math.max(...pgs.map(x => x.dur)) / 60 * 10) / 10;
      out.bloodiest = Math.max(...pgs.map(x => x.k));
      const durs = pgs.map(x => x.dur).filter(x => x > 0);
      if (durs.length) out.shortestGame = Math.round(Math.min(...durs) / 60 * 10) / 10;
      out.mostDeaths = best(new Map([...kd].map(([k, v]) => [k, v.d])), desc);
      out.mostAssists = best(new Map([...kd].map(([k, v]) => [k, v.a])), desc);
      const cw = new Map(), teamGame = new Map();
      for (const g of rows) {
        if (g.win) cw.set(g.champ, (cw.get(g.champ) || 0) + 1);
        const k = g.game + '|' + g.team; teamGame.set(k, (teamGame.get(k) || 0) + g.k);
      }
      if (cw.size) out.champMostWins = best(cw, desc);
      out.distinctChamps = picked.size;
      out.totalGames = perGame.size;
      out.teamKillsGame = Math.max(...teamGame.values());
    return out;
  }

  function pickemTruth(league, stats, schedule, split, playerIndex, official) {
    const ev = ((schedule && schedule.events) || []).filter(e => e.tournament === split && e.state === 'completed').sort((a, b) => a.start.localeCompare(b.start));
    const rows = ((stats && stats.games) || []).filter(g => g.tournament === split);
    const out = {};
    const best = (m, cmp) => { let top = null; const set = new Set(); m.forEach((v, k) => { if (top === null || cmp(v, top) > 0) { top = v; set.clear(); set.add(k); } else if (cmp(v, top) === 0) set.add(k); }); return set; };
    const desc = (a, b) => a - b;
    if (ev.length) {
      const fin = ev[ev.length - 1];
      const w = fin.teams.find(t => t.outcome === 'win');
      if (w) out.champion = new Set([w.code]);
      out.finalist = new Set(fin.teams.map(t => t.code));
      const rec = new Map();
      for (const e of ev) { if (PLAYOFF.test(e.block || '')) continue; for (const t of e.teams) { const r = rec.get(t.code) || { w: 0, l: 0 }; t.outcome === 'win' ? r.w++ : r.l++; rec.set(t.code, r); } }
      const offRank = official && official.stages && official.stages[0] && official.stages[0].sections[0] && official.stages[0].sections[0].rankings;
      if (offRank && offRank.length) {
        const maxOrd = Math.max(...offRank.map(r => r.ordinal));
        out.firstRegular = new Set(offRank.filter(r => r.ordinal === 1).flatMap(r => r.teams.map(t => t.code)));
        out.lastRegular = new Set(offRank.filter(r => r.ordinal === maxOrd).flatMap(r => r.teams.map(t => t.code)));
      } else if (rec.size) {
        const score = new Map([...rec].map(([k, v]) => [k, v.w - v.l]));
        out.firstRegular = best(score, desc);
        out.lastRegular = best(score, (a, b) => b - a);
      }
    }
    Object.assign(out, statTruth(rows, league.scoring));
    return out;
  }

  // {pts, correct:[qid]} for one manager's tips. Numbers: the closest guess(es) win.
  function scoreTips(pe, picks, truth, types) {
    types = types || PICKEM_TYPES;
    const out = { pts: 0, correct: [], hits: {} };
    for (const q of pe.questions || []) {
      const v = picks[q.id];
      if (v === undefined || v === null || v === '') continue;
      const def = types[q.type] || {};
      let ok = false;
      if (def.manual) ok = q.answer !== undefined && q.answer !== null && String(q.answer) === String(v);
      else if (def.kind === 'number') {
        const t = truth[q.type];
        if (typeof t === 'number') {
          const dists = Object.values(pe.picks || {}).map(p => p[q.id]).filter(x => x !== undefined && x !== '').map(x => Math.abs(Number(x) - t));
          ok = Math.abs(Number(v) - t) === Math.min(...dists);
        }
      } else if (def.count) {
        // several picks, points for each one that is right
        const t = truth[q.type];
        if (t instanceof Set) {
          const hits = [...new Set(String(v).split(',').filter(Boolean))].filter(x => t.has(x)).length;
          if (hits) { out.pts += hits * (Number(q.points) || 0); out.correct.push(q.id); out.hits[q.id] = hits; }
        }
        continue;
      } else ok = truth[q.type] instanceof Set && truth[q.type].has(v);
      if (ok) { out.pts += Number(q.points) || 0; out.correct.push(q.id); }
    }
    return out;
  }

  // { manager: { total, bySplit:{split:{pts, correct:[qid]}} } }
  function pickemPoints(league, stats, schedule, playerIndex, officialAll) {
    const res = {};
    for (const [split, pe] of Object.entries(league.pickems || {})) {
      if (!pe || !pe.revealed || !splitDone(schedule, split)) continue;
      const truth = pickemTruth(league, stats, schedule, split, playerIndex, officialAll && officialAll.tournaments && officialAll.tournaments[split]);
      for (const [m, picks] of Object.entries(pe.picks || {})) {
        const r = res[m] || (res[m] = { total: 0, bySplit: {} });
        const sp = r.bySplit[split] = { pts: 0, correct: [] };
        Object.assign(sp, scoreTips(pe, picks, truth));
        r.total += sp.pts;
      }
    }
    return res;
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
    if (mine.length >= rosterSize(league)) return 'Kader voll';
    if (level >= 2) return null;

    const roleCount = {};
    for (const pid of mine) {
      const mm = playerIndex.get(pid);
      if (mm) roleCount[mm.role] = (roleCount[mm.role] || 0) + 1;
    }
    const per = league.roster.perRole;
    if (per) {
      if ((roleCount[meta.role] || 0) >= per) return 'schon ' + per + '× ' + meta.role;
    }
    const need = slots.filter(r => !roleCount[r]);
    if (!per && need.length) {
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

  // Windows between the splits of the season (tradeRules.autoWindows), from
  // season.json: from 6 h after a split's last match until 1 h before the
  // next split's first match (unknown yet -> its start date); after the last
  // split of the season, 30 days.
  function autoWindows(season) {
    const ts = ((season && season.tournaments) || []).slice().sort((a, b) => a.start.localeCompare(b.start));
    const out = [];
    ts.forEach((t, i) => {
      if (!t.lastMatch) return;
      const from = new Date(Date.parse(t.lastMatch) + 6 * 3600e3).toISOString();
      const nx = ts[i + 1];
      const to = nx ? new Date((nx.firstMatch ? Date.parse(nx.firstMatch) : Date.parse(nx.start + 'T00:00:00Z')) - 3600e3).toISOString()
                    : new Date(Date.parse(t.lastMatch) + 30 * 864e5).toISOString();
      if (from < to) out.push({ from, to, label: 'nach ' + t.slug.replace(/^lec_/, '').replace(/_\d{4}$/, '').replace(/_/g, ' '), auto: true });
    });
    return out;
  }
  // {open, current, next} at time `now` (ISO). No window = closed.
  function transferWindow(league, now, season) {
    const r = transferRules(league);
    const t = now || new Date().toISOString();
    if (r.mode === 'always') return { open: true, current: null, next: null };
    const ws = (r.windows || []).filter(w => w && w.from && w.to).concat(r.autoWindows ? autoWindows(season) : [])
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
    const per = (league.roster && league.roster.perRole) || 1;
    if (opts.roles) for (const r of (league.roster && league.roster.slots) || []) if ((roles[r] || 0) < per) out.push(per > 1 ? 'nur ' + (roles[r] || 0) + '× ' + r : 'keine ' + r + ' mehr');
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
  function waiverOrder(league, stats, playerIndex, schedule) {
    const ids = (league.managers || []).map(m => m.id);
    const draftOrder = ((league.draft && league.draft.order) || ids).slice().reverse();
    if (waiverRules(league).order === 'rolling') {
      const base = (league.waiverOrder || []).filter(id => ids.includes(id));
      return base.concat(draftOrder.filter(id => !base.includes(id))).concat(ids.filter(id => !base.includes(id) && !draftOrder.includes(id)));
    }
    const tot = {};
    for (const r of standings(league, stats || { games: [] }, playerIndex, schedule)) tot[r.manager] = r.total;
    return ids.slice().sort((a, b) => (tot[a] || 0) - (tot[b] || 0) || draftOrder.indexOf(a) - draftOrder.indexOf(b));
  }

  // FAAB (tradeRules.waiver.order === 'faab'): every manager has the same
  // budget (league.faab.budget, default 100) for blind bids on free agents.
  // resetEachSplit: the budget refills when a new split starts.
  function faabLeft(league, managerId, season) {
    const f = Object.assign({ budget: 100, resetEachSplit: false }, league.faab || {});
    let since = '';
    if (f.resetEachSplit && season && season.tournaments) {
      const now = new Date().toISOString().slice(0, 10);
      const cur = season.tournaments.filter(t => t.start <= now).pop();
      if (cur) since = cur.start;
    }
    const spent = (league.swaps || []).filter(x => x.manager === managerId && x.by === 'waiver' && x.bid && (x.at || '') >= since)
      .reduce((n, x) => n + Number(x.bid), 0);
    return Math.max(0, f.budget - spent);
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


  // ── weekly recap ────────────────────────────────────────────────────────
  // Everything the "Rückblick" shows for one calendar week. Only players who
  // actually counted (starters after auto-subs, or every owned player when
  // lineups are off) can be player/flop of the week.
  function weekRecap(league, stats, playerIndex, schedule, key, book) {
    book = book || scoreBook(league, stats, playerIndex, schedule);
    const cal = book._cal, sc = league.scoring;
    const rows = ((stats && stats.games) || []).filter(g => cal.blockOf.get(g.match) === key);
    if (!rows.length) return null;
    const pp = new Map();
    for (const g of rows) {
      const x = pp.get(g.player) || { pts: 0, games: 0, ts: g.ts };
      x.pts += gamePoints(g, sc); x.games++; pp.set(g.player, x);
    }
    const ownerAt = ownerResolver(league);
    const lc = lineupConfig(league);
    const ranking = (league.managers || []).map(m => ({ manager: m.id, name: m.name, pts: r2(book[m.id].byBlock[key] || 0) }))
      .sort((a, b) => b.pts - a.pts);
    const counted = [], bench = [];
    for (const m of league.managers || []) {
      const lu = book[m.id].lineups[key];
      if (lc.enabled && lu) {
        for (const id of lu.active) if (pp.has(id)) counted.push({ player: id, manager: m.id, pts: r2(pp.get(id).pts), games: pp.get(id).games, captain: id === lu.captainScored });
        const left = r2(lu.bench.filter(id => !lu.active.includes(id)).reduce((t, id) => t + (pp.has(id) ? pp.get(id).pts : 0), 0));
        if (left > 0) bench.push({ manager: m.id, name: m.name, pts: left });
      }
    }
    if (!lc.enabled) pp.forEach((x, id) => { const m = ownerAt(id, x.ts); if (m) counted.push({ player: id, manager: m, pts: r2(x.pts), games: x.games }); });
    const free = [...pp].filter(([id, x]) => !ownerAt(id, x.ts)).map(([id, x]) => ({ player: id, pts: r2(x.pts), games: x.games }));
    const top = (list, dir) => list.length ? list.reduce((a, b) => (dir * (b.pts - a.pts) > 0 ? b : a)) : null;
    // weekly high score of the season so far (this week included)
    let record = 0;
    for (const m of league.managers || []) for (const [k, v] of Object.entries(book[m.id].byBlock)) if (cal.start.get(k) <= cal.start.get(key)) record = Math.max(record, v);
    return {
      key, week: cal.name(key), split: cal.split(key), ranking,
      best: top(counted, 1), flop: top(counted, -1), benchPain: top(bench, 1), freeBest: top(free, 1),
      record: ranking.length > 0 && ranking[0].pts > 0 && ranking[0].pts >= record,
    };
  }

  // ── hall of fame ────────────────────────────────────────────────────────
  // A frozen snapshot per finished split (names stored, so it survives
  // managers leaving and new seasons). Draft steal / bust compare the overall
  // pick number with where that player finished in points among all drafted
  // players in this split.
  function hallEntry(league, stats, playerIndex, schedule, split, officialAll) {
    const book = scoreBook(league, stats, playerIndex, schedule), cal = book._cal;
    const pk = pickemPoints(league, stats, schedule, playerIndex, officialAll);
    const mgrs = league.managers || [];
    const table = mgrs.map(m => {
      let pts = 0;
      for (const [k, v] of Object.entries(book[m.id].byBlock)) if (cal.split(k) === split) pts += v;
      const pick = ((pk[m.id] || {}).bySplit || {})[split];
      return { manager: m.id, name: m.name, players: r2(pts), pickem: pick ? pick.pts : 0, pts: r2(pts + (pick ? pick.pts : 0)) };
    }).sort((a, b) => b.pts - a.pts);
    const pickemKing = table.filter(r => r.pickem > 0).sort((a, b) => b.pickem - a.pickem)[0] || null;
    let bestWeek = null;
    for (const m of mgrs) for (const [k, v] of Object.entries(book[m.id].byBlock)) {
      // playoffs are one multi-weekend block in the data - not a fair "week"
      if (cal.split(k) === split && !/playoff|final/i.test(cal.name(k)) && (!bestWeek || v > bestWeek.pts)) bestWeek = { manager: m.id, name: m.name, week: cal.name(k), pts: r2(v) };
    }
    const sp = new Map();
    for (const g of (stats && stats.games) || []) if (g.tournament === split) sp.set(g.player, (sp.get(g.player) || 0) + gamePoints(g, league.scoring));
    const picks = ((league.draft && league.draft.picks) || []).filter(x => x && x.player);
    const ranked = picks.map(x => x.player).sort((a, b) => (sp.get(b) || 0) - (sp.get(a) || 0));
    const nameOf = id => (mgrs.find(m => m.id === id) || {}).name || '?';
    const entries = picks.map((x, i) => ({ player: x.player, playerName: ((playerIndex && playerIndex.get(x.player)) || {}).name || x.player,
      manager: x.manager, name: nameOf(x.manager), pick: i + 1, rank: ranked.indexOf(x.player) + 1, pts: r2(sp.get(x.player) || 0) }));
    const steal = entries.length ? entries.reduce((a, b) => (b.pick - b.rank > a.pick - a.rank ? b : a)) : null;
    const bust = entries.length ? entries.reduce((a, b) => (b.rank - b.pick > a.rank - a.pick ? b : a)) : null;
    return { split, at: new Date().toISOString(), table, pickemKing, bestWeek,
             steal: steal && steal.pick > steal.rank ? steal : null, bust: bust && bust.rank > bust.pick ? bust : null };
  }
  // splits whose hall entry is due: finished >= 12 h ago, and the league was
  // already drafted before the split's last match (no fame for replayed history)
  function hallDue(league, season, now) {
    const started = league.draft && league.draft.startedAt;
    if (draftStatus(league) !== 'done' || !started) return [];
    const t = now || Date.now();
    return ((season && season.tournaments) || []).filter(x => x.lastMatch && x.done !== false
      && Date.parse(x.lastMatch) + 12 * 3600e3 <= t && started < x.lastMatch && !(league.hall || {})[x.slug]).map(x => x.slug);
  }

  // ── special events (First Stand, MSI, Worlds) ───────────────────────────
  // league.events[slug] = { slug, name, budget, maxPerTeam, prices:{team:n},
  //   captain, video, accent, pickem:{questions, lockAt, revealed, picks},
  //   lineups:{ [stage]: { [manager]: {players:[5 ids], captain} } }, createdAt }
  // evData = data/events/<slug>.json. Every manager builds 5 players (one per
  // role) within the budget; two managers may own the same player. A stage's
  // lineup locks at its first match; without a new one, the last carries on.
  const EVENT_TYPES = {
    champion:    { kind: 'team',   label: 'Turniersieger' },
    advance8:    { kind: 'team',   count: 8, label: 'Die 8 Teams in der K.-o.-Phase (Punkte pro richtigem Team)' },
    swiss30s:    { kind: 'team',   count: 2, label: 'Swiss: die zwei 3-0-Teams (pro Treffer)' },
    swissAdv6:   { kind: 'team',   count: 6, label: 'Swiss: 6 Teams, die mit 3-1 oder 3-2 weiterkommen (pro Treffer)' },
    swiss03s:    { kind: 'team',   count: 2, label: 'Swiss: die zwei 0-3-Teams (pro Treffer)' },
    koSemis:     { kind: 'team',   count: 4, label: 'Die 4 Halbfinalisten (pro Treffer)' },
    koFinal:     { kind: 'team',   count: 2, label: 'Die 2 Finalisten (pro Treffer)' },
    finalScore:  { kind: 'score',  label: 'Genaues Ergebnis im Finale (Sieger zuerst)' },
    bestLec:     { kind: 'stage',  label: 'Wie weit kommt das beste LEC-Team?' },
    regionMostKo:{ kind: 'region', label: 'Region mit den meisten Teams in der K.-o.-Phase' },
    shortestGame:{ kind: 'number', label: 'Kürzestes Spiel (Minuten, wer am nächsten liegt)' },
    mostDeaths:  { kind: 'player', label: 'Meiste Tode (Spieler)' },
    mostAssists: { kind: 'player', label: 'Meiste Assists (Spieler)' },
    champMostWins:{ kind: 'champion', label: 'Champion mit den meisten Siegen' },
    distinctChamps:{ kind: 'number', label: 'Wie viele verschiedene Champions werden gespielt? (am nächsten)' },
    totalGames:  { kind: 'number', label: 'Wie viele Spiele hat das Event? (am nächsten)' },
    teamKillsGame:{ kind: 'number', label: 'Meiste Kills eines Teams in einem Spiel (am nächsten)' },
    finalist:    { kind: 'team',   label: 'Ein Finalist' },
    swiss30:     { kind: 'team',   label: 'Ein Team, das die Swiss-Phase 3-0 gewinnt' },
    swiss03:     { kind: 'team',   label: 'Ein Team, das in der Swiss-Phase 0-3 rausfliegt' },
    winnerRegion:{ kind: 'region', label: 'Region des Siegers' },
    mostKills: PICKEM_TYPES.mostKills, mostPoints: PICKEM_TYPES.mostPoints, bestKda: PICKEM_TYPES.bestKda,
    mostChamps: PICKEM_TYPES.mostChamps, maxKillsGame: PICKEM_TYPES.maxKillsGame, mostPicked: PICKEM_TYPES.mostPicked,
    longestGame: PICKEM_TYPES.longestGame, bloodiest: PICKEM_TYPES.bloodiest,
    manualChamp: PICKEM_TYPES.manualChamp, manualTeam: PICKEM_TYPES.manualTeam, manualPlayer: PICKEM_TYPES.manualPlayer,
  };
  const EVENT_PRICE = { LCK: 25, LPL: 25, LEC: 20 };
  function eventConfig(ev) {
    return Object.assign({ budget: 100, maxPerTeam: 2, captain: 1.5, prices: {} }, ev || {});
  }
  function eventTeamPrice(ev, evData, code) {
    const p = eventConfig(ev).prices[code];
    if (typeof p === 'number') return p;
    const t = ((evData && evData.teams) || []).find(x => x.code === code);
    return EVENT_PRICE[t && t.league] || 15;
  }
  function eventPlayer(evData, id) { return ((evData && evData.players) || []).find(p => p.id === id) || null; }
  function eventPrice(ev, evData, id) { const p = eventPlayer(evData, id); return p ? eventTeamPrice(ev, evData, p.team) : 0; }
  // [{i, name, lock (ms|null), end (ms|null), done}]
  function eventStages(evData) {
    const sched = (evData && evData.schedule) || [];
    return ((evData && evData.stages) || []).map((st, i) => {
      const ev = sched.filter(e => e.stage === i);
      const ts = ev.map(e => Date.parse(e.start)).filter(Boolean);
      return { i, name: st.name, lock: ts.length ? Math.min(...ts) : null, end: ts.length ? Math.max(...ts) : null,
               done: ev.length > 0 && ev.every(e => e.state === 'completed') };
    });
  }
  // the stage a lineup saved now is for (first one not started); null = event over
  function eventOpenStage(evData, now) {
    const t = now === undefined ? Date.now() : now;
    const st = eventStages(evData).find(x => x.lock === null || x.lock > t);
    return st ? st.i : null;
  }
  function eventDone(evData) {
    const sched = (evData && evData.schedule) || [];
    const ko = eventStages(evData).slice(-1)[0];
    return sched.length > 0 && sched.every(e => e.state === 'completed') && !!ko && ko.done;
  }
  // null when fine, else the reason (German, shown to the user)
  function eventTeamError(ev, evData, sel) {
    const c = eventConfig(ev);
    const ids = (sel && sel.players) || [];
    if (ids.length !== 5 || new Set(ids).size !== 5) return 'Genau 5 verschiedene Spieler.';
    const ps = ids.map(id => eventPlayer(evData, id));
    if (ps.some(p => !p)) return 'Ein Spieler spielt bei diesem Event nicht mit.';
    const roles = ps.map(p => p.role);
    for (const r of ['TOP', 'JNG', 'MID', 'BOT', 'SUP']) if (!roles.includes(r)) return 'Je ein Spieler pro Rolle (Top, Jungle, Mid, Bot, Support).';
    const per = {};
    for (const p of ps) per[p.team] = (per[p.team] || 0) + 1;
    const over = Object.keys(per).find(k => per[k] > c.maxPerTeam);
    if (over) return `Höchstens ${c.maxPerTeam} Spieler pro Team (${over}).`;
    const cost = ids.reduce((t, id) => t + eventPrice(ev, evData, id), 0);
    if (cost > c.budget) return `Zu teuer: ${cost} von ${c.budget}.`;
    if (!ids.includes(sel.captain)) return 'Wähl einen Kapitän aus deinen 5.';
    return null;
  }
  function eventLineup(ev, manager, stage) {
    const L = (ev && ev.lineups) || {};
    for (let i = stage; i >= 0; i--) if (L[i] && L[i][manager]) return L[i][manager];
    return null;
  }
  // how far a team got: stage index, then semifinal / final / winner inside the knockouts
  function eventLevels(evData) {
    const st = ((evData && evData.stages) || []).map(s => s.name);
    return st.slice(0, -1).concat(st.length ? [st[st.length - 1], 'Halbfinale', 'Finale', 'Sieger'] : []);
  }
  function eventTeamLevel(evData, code) {
    const sched = (evData && evData.schedule) || [], n = ((evData && evData.stages) || []).length;
    let lv = -1;
    for (const e of sched) if (e.teams.some(t => t.code === code)) lv = Math.max(lv, e.stage === null || e.stage === undefined ? -1 : e.stage);
    if (lv === n - 1) {
      const kos = sched.filter(e => e.stage === n - 1).sort((a, b) => a.start.localeCompare(b.start));
      const fin = kos[kos.length - 1];
      if (kos.slice(-3).some(e => e.teams.some(t => t.code === code))) lv = n;
      if (fin && fin.teams.some(t => t.code === code)) lv = n + 1;
      if (fin && fin.teams.some(t => t.code === code && t.outcome === 'win')) lv = n + 2;
    }
    return Math.max(0, lv);
  }
  function eventFinalScores(evData) {
    const sched = (evData && evData.schedule) || [], n = ((evData && evData.stages) || []).length;
    const fin = sched.filter(e => e.stage === n - 1).sort((a, b) => a.start.localeCompare(b.start)).pop();
    const bo = (fin && fin.bestOf) || 5, need = Math.ceil(bo / 2);
    const out = []; for (let l = 0; l < need; l++) out.push(`${need}:${l}`);
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BINGO - the minigame inside the pickem.
  //
  // A card of squares that tick THEMSELVES as games land, so the thing is
  // alive during the tournament instead of being a form you submit once.
  // Every square is a predicate over the player-game rows we already fetch
  // (k/d/a/cs/champ/role/win/dur), so nothing here needs an admin answer.
  //
  // Difficulty was tuned against the real MSI 2026 event file (71 games,
  // 710 player-games). Squares that never happened were dropped - a dead
  // square is a wasted tile. Notably "a support is the top killer of a game"
  // occurred 0/71 times and is NOT in here.
  // ═══════════════════════════════════════════════════════════════════════
  const BINGO = {
    // Calibrated on 116 real games (MSI 2026 + First Stand 2026). The number
    // is the measured per-game hit rate; the aim is 2-10%, which leaves a
    // square 35-70% likely to still be OPEN after a 20-game stage. The first
    // draft used much softer thresholds and every card filled completely well
    // before the final - everyone scored the same and the game was dead.
    kills12:     { label: '12+ Kills',                   hint: 'ein Spieler in einem Spiel', rate: .103,
                   test: (g) => g.some(x => x.k >= 12) },
    cs400:       { label: '400+ CS',                     hint: 'ein Spieler in einem Spiel', rate: .103,
                   test: (g) => g.some(x => x.cs >= 400) },
    under25:     { label: 'Spiel unter 25 Min',          hint: 'Stomp', rate: .052,
                   test: (g) => !!g[0].dur && g[0].dur < 25 * 60 },
    zeroKA:      { label: 'Spieler 0 Kills & 0 Assists', hint: 'komplett unsichtbar', rate: .052,
                   test: (g) => g.some(x => x.k === 0 && x.a === 0) },
    cs450:       { label: '450+ CS',                     hint: 'Farm-Monster', rate: .043,
                   test: (g) => g.some(x => x.cs >= 450) },
    kills50game: { label: '50+ Kills im Spiel',          hint: 'beide Teams zusammen', rate: .034,
                   test: (g) => g.reduce((t, x) => t + x.k, 0) >= 50 },
    over45:      { label: 'Spiel ueber 45 Min',          hint: 'Marathon', rate: .026,
                   test: (g) => !!g[0].dur && g[0].dur > 45 * 60 },
    deaths10:    { label: 'Spieler mit 10+ Toden',       hint: 'ganz schwerer Tag', rate: .026,
                   test: (g) => g.some(x => x.d >= 10) },
    kills15:     { label: '15+ Kills',                   hint: 'Hard Carry', rate: .017,
                   test: (g) => g.some(x => x.k >= 15) },
    kills55game: { label: '55+ Kills im Spiel',          hint: 'Blutbad', rate: .017,
                   test: (g) => g.reduce((t, x) => t + x.k, 0) >= 55 },
    under22:     { label: 'Spiel unter 22 Min',          hint: 'absoluter Stomp', rate: .009,
                   test: (g) => !!g[0].dur && g[0].dur < 22 * 60 },
    over50:      { label: 'Spiel ueber 50 Min',          hint: 'nie endender Krieg', rate: .009,
                   test: (g) => !!g[0].dur && g[0].dur > 50 * 60 },
    teamDeaths2: { label: 'Team mit max. 2 Toden',       hint: 'im ganzen Spiel', rate: .009,
                   test: (g) => { const t = {}; for (const x of g) t[x.team] = (t[x.team] || 0) + x.d;
                     return Object.values(t).some(v => v <= 2); } },
    // Harder variants of the mid-frequency ones, so a card is not all extremes
    perfect18:   { label: 'KDA 18+ ohne Tod',            hint: 'K+A >= 18, keine Tode', rate: .10,
                   test: (g) => g.some(x => x.d === 0 && x.k + x.a >= 18) },
    fewerKillsWin:{ label: 'Sieger mit weniger Kills',   hint: 'Objectives > Kills', rate: .19,
                   test: (g) => { const t = {}; for (const x of g) { const e = t[x.team] || (t[x.team] = { k: 0, w: x.win }); e.k += x.k; }
                     const v = Object.values(t); return v.length === 2 && ((v[0].w && v[0].k < v[1].k) || (v[1].w && v[1].k < v[0].k)); } },
    jglMostKills:{ label: 'Jungler Top-Killer',          hint: 'mehr Kills als alle anderen', rate: .155,
                   test: (g) => { const m = Math.max(...g.map(x => x.k)); return m > 0 && g.some(x => x.role === 'JNG' && x.k === m); } },
    supCarry:    { label: 'Support mit 6+ Kills',        hint: 'Support geht steil', rate: .03,
                   test: (g) => g.some(x => x.role === 'SUP' && x.k >= 6) },
    soloHalf:    { label: 'Ein Spieler holt 50% der Teamkills', hint: 'mind. 8 Kills', rate: .09,
                   test: (g) => { const t = {}; for (const x of g) (t[x.team] = t[x.team] || []).push(x);
                     return Object.values(t).some(ps => { const tot = ps.reduce((a, b) => a + b.k, 0);
                       return tot > 0 && ps.some(pl => pl.k >= 8 && pl.k / tot >= 0.5); }); } },

    // ── added for the 5x5 card ───────────────────────────────────────────
    // A 5x5 needs 25 distinct squares; with only 18 every card repeated 7 of
    // them, which makes lines complete in lockstep and flattens the scoring.
    // These were measured on the same 116 games and all sit in the 6-17% band.
    botDeaths6:  { label: 'ADC mit 6+ Toden',            hint: 'schwerer Tag fuer den Carry', rate: .164,
                   test: (g) => g.some(x => x.role === 'BOT' && x.d >= 6) },
    mid3540:     { label: 'Spiel zwischen 35 und 40 Min', hint: 'die klassische Laenge', rate: .155,
                   test: (g) => { const d = g[0].dur || 0; return d >= 35 * 60 && d <= 40 * 60; } },
    topMostKills:{ label: 'Toplaner Top-Killer',         hint: 'mehr Kills als alle anderen', rate: .147,
                   test: (g) => { const m = Math.max(...g.map(x => x.k)); return m > 0 && g.some(x => x.role === 'TOP' && x.k === m); } },
    jglNoKills:  { label: 'Jungler ohne einen Kill',     hint: '0 Kills im ganzen Spiel', rate: .147,
                   test: (g) => g.some(x => x.role === 'JNG' && x.k === 0) },
    over38:      { label: 'Spiel ueber 38 Min',          hint: 'zieht sich', rate: .138,
                   test: (g) => !!g[0].dur && g[0].dur > 38 * 60 },
    teamDeaths4: { label: 'Team mit max. 4 Toden',       hint: 'saubere Runde', rate: .129,
                   test: (g) => { const t = {}; for (const x of g) t[x.team] = (t[x.team] || 0) + x.d;
                     return Object.values(t).some(v => v <= 4); } },
    supAssists20:{ label: 'Support mit 20+ Assists',     hint: 'ueberall dabei', rate: .103,
                   test: (g) => g.some(x => x.role === 'SUP' && x.a >= 20) },
    bothTeams20: { label: 'Beide Teams 20+ Kills',       hint: 'offene Schlacht', rate: .078,
                   test: (g) => { const t = {}; for (const x of g) t[x.team] = (t[x.team] || 0) + x.k;
                     const v = Object.values(t); return v.length === 2 && v.every(k => k >= 20); } },
    shutout:     { label: 'Team mit max. 3 Kills',       hint: 'komplett ueberrannt', rate: .069,
                   test: (g) => { const t = {}; for (const x of g) t[x.team] = (t[x.team] || 0) + x.k;
                     return Object.values(t).some(k => k <= 3); } },
    kda20:       { label: 'K+A 20+ ohne Tod',            hint: 'perfektes Spiel', rate: .069,
                   test: (g) => g.some(x => x.d === 0 && x.k + x.a >= 20) },
    team30Kills: { label: 'Team mit 30+ Kills',          hint: 'Massaker', rate: .060,
                   test: (g) => { const t = {}; for (const x of g) t[x.team] = (t[x.team] || 0) + x.k;
                     return Object.values(t).some(k => k >= 30); } },
  };

  // Which squares are already ticked, given the games of an event (or season).
  // Returns { key: {hit, at, game} } - `at` is the kickoff of the game that did it.
  function bingoHits(rows) {
    const byGame = new Map();
    for (const x of rows || []) { if (!byGame.has(x.game)) byGame.set(x.game, []); byGame.get(x.game).push(x); }
    const games = [...byGame.entries()].sort((a, b) => String(a[1][0].ts || '').localeCompare(String(b[1][0].ts || '')));
    const out = {};
    for (const [key, sq] of Object.entries(BINGO)) {
      out[key] = { hit: false, at: null, game: null };
      for (const [gid, g] of games) {
        let ok = false;
        try { ok = sq.test(g); } catch (e) { ok = false; }
        if (ok) { out[key] = { hit: true, at: g[0].ts || null, game: gid }; break; }
      }
    }
    return out;
  }

  // Games of one stage only. Bingo is scored PER STAGE, not per event: over a
  // whole tournament every square eventually ticks (measured on MSI 2026: the
  // card was full after 45 of 71 games, so everyone ended on the same score and
  // the game was over before the final). A fresh card per stage keeps it live
  // to the last day and makes Play-Ins / Swiss / Knockouts each worth playing.
  function bingoStageRows(evData, stageIndex) {
    const sched = (evData && evData.schedule) || [];
    const ids = new Set();
    for (const e of sched) {
      if (e.stage !== stageIndex) continue;
      for (const g of (e.games || [])) if (g && g.id) ids.add(String(g.id));
      if (e.match) ids.add(String(e.match));
    }
    const rows = (evData && evData.games) || [];
    // match games to the stage by match id when we have it, else by date range
    const byMatch = rows.filter(r => ids.has(String(r.match)));
    // rows that name their match never fall back to dates: a phase without
    // games yet must stay empty (a replay squeezes all phases into minutes,
    // so a date window would pull in the previous phase's games)
    if (byMatch.length || rows.some(r => r.match)) return byMatch;
    const ts = sched.filter(e => e.stage === stageIndex).map(e => Date.parse(e.start)).filter(Boolean);
    if (!ts.length) return [];
    const lo = Math.min(...ts) - 6 * 3600e3, hi = Math.max(...ts) + 18 * 3600e3;
    return rows.filter(r => { const t = Date.parse(r.ts); return t >= lo && t <= hi; });
  }

  // A player's card: size x size keys, drawn deterministically from their id
  // so everyone gets a different card but the same card every time they look.
  // Seed with manager + stage so each stage is a genuinely new card.
  const BINGO_RARE = 0.03;   // a square hit in at most 3% of games counts as rare
  function bingoCard(seed, size) {
    size = size || 5;   // 5x5 is the classic bingo card
    const keys = Object.keys(BINGO);
    const need = size * size;
    let h = 2166136261;
    const str = String(seed);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
    const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
    // Every row and column gets exactly one RARE square (hit rate <= 3%), and
    // each diagonal at least one - so no line is finished on common squares
    // alone. Rare squares sit on a random permutation; the rest is common.
    const rare = shuffle(keys.filter(k => BINGO[k].rate <= BINGO_RARE));
    const common = shuffle(keys.filter(k => BINGO[k].rate > BINGO_RARE));
    if (rare.length < size || rare.length + common.length < need) {
      const pool = shuffle(keys.slice()), cells = [];
      for (let i = 0; i < need; i++) cells.push(pool[i % pool.length]);
      return { size, cells, rare: [] };
    }
    let perm;
    for (let t = 0; t < 200; t++) {
      perm = shuffle([...Array(size).keys()]);                       // row r -> column perm[r]
      if (perm.some((c, r) => c === r) && perm.some((c, r) => c === size - 1 - r)) break;
    }
    const cells = new Array(need), rarePos = [];
    perm.forEach((c, r) => { cells[r * size + c] = rare[r]; rarePos.push(r * size + c); });
    let k = 0;
    for (let i = 0; i < need; i++) if (!cells[i]) cells[i] = common[k++ % common.length];
    return { size, cells, rare: rarePos };
  }

  // Score a card: points per square, per completed line, plus a full-house bonus.
  //
  // Weighting note: with 29 squares on a 5x5 card everyone ends up holding
  // almost the same set, so scoring mostly by SQUARES made every manager score
  // within a point of each other (measured on MSI Play-Ins: 20/21/21/21).
  // Lines are where cards actually differ - which squares sit next to each
  // other is random per manager - so lines carry the weight and a bare square
  // is worth little.
  function bingoScore(card, hits, cfg) {
    cfg = Object.assign({ line: 12, full: 40, square: 0.5 }, cfg || {});
    const n = card.size, on = i => !!(hits[card.cells[i]] || {}).hit;
    const lines = [];
    for (let r = 0; r < n; r++) { const l = []; for (let c = 0; c < n; c++) l.push(r * n + c); lines.push(l); }
    for (let c = 0; c < n; c++) { const l = []; for (let r = 0; r < n; r++) l.push(r * n + c); lines.push(l); }
    const d1 = [], d2 = [];
    for (let i = 0; i < n; i++) { d1.push(i * n + i); d2.push(i * n + (n - 1 - i)); }
    lines.push(d1); lines.push(d2);
    const done = lines.filter(l => l.every(on));
    let squares = 0;
    for (let i = 0; i < card.cells.length; i++) if (on(i)) squares++;
    const full = squares === n * n;
    return { squares, lines: done.length, full,
             points: r2(squares * cfg.square + done.length * cfg.line + (full ? cfg.full : 0)),
             lineCells: done };
  }

  function eventTruth(evData, scoring) {
    const out = statTruth((evData && evData.games) || [], scoring);
    const stages = eventStages(evData), sched = (evData && evData.schedule) || [];
    const ko = stages[stages.length - 1];
    if (ko && ko.done) {
      const fin = sched.filter(e => e.stage === ko.i).sort((a, b) => a.start.localeCompare(b.start)).pop();
      const w = fin && fin.teams.find(t => t.outcome === 'win');
      if (fin) out.finalist = new Set(fin.teams.map(t => t.code));
      if (w) {
        out.champion = new Set([w.code]);
        const team = ((evData && evData.teams) || []).find(t => t.code === w.code);
        if (team && team.league) out.winnerRegion = new Set([team.league]);
      }
    }
    // knockout field: once the stage before it is over, its teams are known
    if (ko && stages.length > 1 && stages[ko.i - 1] && stages[ko.i - 1].done) {
      const field = new Set(sched.filter(e => e.stage === ko.i).flatMap(e => e.teams.map(t => t.code)).filter(c => c && c !== 'TBD'));
      if (field.size) {
        out.advance8 = field;
        const by = {};
        for (const c of field) { const t = ((evData && evData.teams) || []).find(x => x.code === c); if (t && t.league) by[t.league] = (by[t.league] || 0) + 1; }
        const top = Math.max(0, ...Object.values(by));
        if (top) out.regionMostKo = new Set(Object.keys(by).filter(k => by[k] === top));
      }
    }
    if (ko && ko.done) {
      const kos = sched.filter(e => e.stage === ko.i).sort((a, b) => a.start.localeCompare(b.start));
      out.koSemis = new Set(kos.slice(-3).flatMap(e => e.teams.map(t => t.code)));
      if (out.finalist) out.koFinal = out.finalist;
      const fin = kos[kos.length - 1];
      const w = fin && fin.teams.find(t => t.outcome === 'win'), l = fin && fin.teams.find(t => t.outcome === 'loss');
      if (w && l && w.wins !== undefined && w.wins !== null) out.finalScore = new Set([`${w.wins}:${l.wins || 0}`]);
      // the best LEC team's level
      const lv = eventLevels(evData), lec = ((evData && evData.teams) || []).filter(t => t.league === 'LEC').map(t => t.code);
      if (lec.length) out.bestLec = new Set([lv[Math.max(...lec.map(c => eventTeamLevel(evData, c)))]]);
    }
    const si = ((evData && evData.stages) || []).findIndex(st => /swiss/i.test(st.name));
    if (si >= 0 && stages[si] && stages[si].done) {
      const rec = {};
      for (const e of sched.filter(x => x.stage === si)) for (const t of e.teams) {
        const r = rec[t.code] || (rec[t.code] = { w: 0, l: 0 });
        if (t.outcome === 'win') r.w++; else if (t.outcome === 'loss') r.l++;
      }
      out.swiss30 = new Set(Object.keys(rec).filter(k => rec[k].w === 3 && rec[k].l === 0));
      out.swiss03 = new Set(Object.keys(rec).filter(k => rec[k].w === 0 && rec[k].l === 3));
      out.swiss30s = out.swiss30; out.swiss03s = out.swiss03;
      out.swissAdv6 = new Set(Object.keys(rec).filter(k => rec[k].w === 3 && (rec[k].l === 1 || rec[k].l === 2)));
    }
    return out;
  }
  // Test replay of a finished event: replay = { from (ms), first (ms), speed }.
  // Original time t plays at from + (t - first) / speed. A match counts as
  // finished once its games (by their length) are over in replay time; until
  // then it has no result and its games are not in the stats.
  function eventReplay(raw, replay, now) {
    if (!raw || !replay) return raw;
    const t = now === undefined ? Date.now() : now;
    const map = ms => replay.from + (ms - replay.first) / replay.speed;
    const durOf = {};
    for (const g of raw.games || []) durOf[g.match] = (durOf[g.match] || 0) + ((g.dur || 1800) * 1000 + 10 * 60000) / 10;   // 10 rows per game
    // like the real schedule: later rounds are TBD until they start
    const firstDay = {};
    for (const e of raw.schedule || []) { const k = e.stage, dd = e.start.slice(0, 10); if (!firstDay[k] || dd < firstDay[k]) firstDay[k] = dd; }
    const done = new Set(), schedule = (raw.schedule || []).map(e => {
      const start = map(Date.parse(e.start)), end = map(Date.parse(e.start) + (durOf[e.match] || 3600e3));
      const st = t >= end ? 'completed' : t >= start ? 'inProgress' : 'unstarted';
      if (st === 'completed') done.add(e.match);
      return Object.assign({}, e, { start: new Date(start).toISOString(), state: st,
        teams: st === 'completed' ? e.teams : e.teams.map(x => ({ code: st === 'unstarted' && e.start.slice(0, 10) > firstDay[e.stage] ? 'TBD' : x.code })) });
    });
    const games = (raw.games || []).filter(g => done.has(g.match)).map(g => Object.assign({}, g, { ts: new Date(map(Date.parse(g.ts))).toISOString() }));
    return Object.assign({}, raw, { schedule, games, replay: true });
  }
  function eventReplayPlan(raw, minutes, leadMinutes, now) {
    const ts = (raw.schedule || []).map(e => Date.parse(e.start)).filter(Boolean);
    const first = Math.min(...ts), last = Math.max(...ts) + 4 * 3600e3;
    return { from: (now === undefined ? Date.now() : now) + leadMinutes * 60000, first, speed: (last - first) / (minutes * 60000) };
  }
  // [{manager, name, players, pickem, total, byStage:{i:pts}, perPlayer:{id:pts}, correct:[qid]}] best first
  function eventStandings(league, ev, evData) {
    const c = eventConfig(ev), sc = league.scoring;
    const stageOf = new Map(((evData && evData.schedule) || []).map(e => [e.match, e.stage]));
    const rounds = [ev.pickem, ev.pickemKo].filter(x => x && x.revealed);
    const truth = rounds.length && eventDone(evData) ? eventTruth(evData, sc) : null;
    const rows = (league.managers || []).map(m => {
      const r = { manager: m.id, name: m.name, players: 0, pickem: 0, bingo: 0, total: 0, byStage: {}, perPlayer: {}, correct: [] };
      for (const g of (evData && evData.games) || []) {
        const st = stageOf.get(g.match);
        if (st === undefined || st === null) continue;
        const lu = eventLineup(ev, m.id, st);
        if (!lu || !lu.players.includes(g.player)) continue;
        let pts = gamePoints(g, sc);
        if (g.player === lu.captain) pts *= c.captain;
        pts = r2(pts);
        r.players += pts; r.byStage[st] = r2((r.byStage[st] || 0) + pts); r.perPlayer[g.player] = r2((r.perPlayer[g.player] || 0) + pts);
      }
      if (truth) for (const pe of rounds) {
        const t = scoreTips(pe, (pe.picks || {})[m.id] || {}, truth, EVENT_TYPES);
        r.pickem += t.pts; r.correct = r.correct.concat(t.correct.map(q => (pe === ev.pickemKo ? 'ko:' : '') + q));
        Object.entries(t.hits).forEach(([q, h]) => { (r.hits = r.hits || {})[(pe === ev.pickemKo ? 'ko:' : '') + q] = h; });
      }
      // Bingo: one card per manager per stage, scored from the games of that
      // stage. Opt-in via league.bingo.enabled so an event can run without it.
      const bcfg = (league.bingo || {});
      if (bcfg.enabled !== false && evData) {
        for (const st of eventStages(evData)) {
          const rows = bingoStageRows(evData, st.i);
          if (!rows.length) continue;
          const sc = bingoScore(bingoCard(m.id + '|' + (evData.slug || ev.slug || '') + '|' + st.i), bingoHits(rows), bcfg);
          r.bingo += sc.points;
        }
        r.bingo = r2(r.bingo);
      }
      r.players = r2(r.players); r.total = r2(r.players + r.pickem + r.bingo);
      return r;
    });
    return rows.sort((a, b) => b.total - a.total);
  }

  global.LECScoring = {
    gamePoints, byPlayer, playerTotal, applyOverrides,
    draftStatus, rosterSize, capacity,
    rosterEvents, ownership, rosters, standings, weeklyPoints, ownerResolver,
    h2hPairs, h2h,
    pickError, relaxLevel, currentPicker, draftProgress, validateLeague,
    transferRules, transferWindow, rosterProblems, weekKey,
    berlinParts, berlinAt, waiverRules, waiverSlots, nextWaiverRun, lastWaiverSlot, waiverOrder,
    suggestedCapacity, calendar, blockKey, lineupConfig, lineupFor, lineupPreview, scoreBook, autoWindows, faabLeft,
    PICKEM_TYPES, pickemTruth, pickemPoints, pickemLock, splitDone,
    weekRecap, hallEntry, hallDue, statTruth, scoreTips,
    BINGO, bingoHits, bingoCard, bingoScore, bingoStageRows,
    EVENT_TYPES, eventConfig, eventTeamPrice, eventPrice, eventPlayer, eventStages, eventOpenStage, eventDone, eventTeamError, eventLineup, eventTruth, eventStandings, eventReplay, eventReplayPlan, eventLevels, eventTeamLevel, eventFinalScores
  };
// `this` is undefined in an ES module, so a Cloudflare Worker importing this
// file would crash on a bare `this`. globalThis works in every place these
// rules run: browser, node test harness, Worker.
})(typeof window !== 'undefined' ? window : globalThis);
