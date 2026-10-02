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
    const score = id => avgBefore(ctx.hist, id, t0);
    const byScore = ids => ids.slice().sort((a, b) => score(b) - score(a) || String(a).localeCompare(String(b)));
    // this week's lineup, else the most recent earlier one (carried forward,
    // like Fantasy Premier League keeps your team), else automatic
    const mine = ((league.lineups || {})[managerId]) || {};
    let saved = mine[key];
    if (!saved) {
      const earlier = ctx.cal.keys.slice(0, ctx.cal.keys.indexOf(key)).reverse().find(k => mine[k]);
      if (earlier) saved = mine[earlier];
    }
    const starters = [];
    let auto = true;
    if (saved && Array.isArray(saved.starters)) {
      auto = false;
      for (const r of slots) {
        const pick = saved.starters.find(id => roster.includes(id) && role(id) === r);
        if (pick) starters.push(pick);
        else { auto = true; const best = byScore(roster.filter(id => role(id) === r))[0]; if (best) starters.push(best); }
      }
    } else {
      for (const r of slots) { const best = byScore(roster.filter(id => role(id) === r))[0]; if (best) starters.push(best); }
    }
    const benchSaved = saved && Array.isArray(saved.bench) ? saved.bench.filter(id => roster.includes(id) && !starters.includes(id)) : [];
    const bench = benchSaved.concat(byScore(roster.filter(id => !starters.includes(id) && !benchSaved.includes(id))));
    const ranked = byScore(starters);
    let captain = saved && starters.includes(saved.captain) ? saved.captain : ranked[0];
    let vice = saved && starters.includes(saved.vice) && saved.vice !== captain ? saved.vice : ranked.find(id => id !== captain);
    return { starters, bench, captain, vice, auto, roster };
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
    if (rows.length) {
      const kills = new Map(), pts = new Map(), games = new Map(), kd = new Map(), champs = new Map(), picked = new Map(), maxK = new Map();
      const perGame = new Map();
      for (const g of rows) {
        kills.set(g.player, (kills.get(g.player) || 0) + g.k);
        pts.set(g.player, (pts.get(g.player) || 0) + gamePoints(g, league.scoring));
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
        for (const q of pe.questions || []) {
          const v = picks[q.id];
          if (v === undefined || v === null || v === '') continue;
          const def = PICKEM_TYPES[q.type] || {};
          let ok = false;
          if (def.manual) ok = q.answer !== undefined && q.answer !== null && String(q.answer) === String(v);
          else if (def.kind === 'number') {
            // closest guess(es) win
            const t = truth[q.type];
            if (typeof t === 'number') {
              const dists = Object.values(pe.picks).map(p => p[q.id]).filter(x => x !== undefined && x !== '').map(x => Math.abs(Number(x) - t));
              ok = Math.abs(Number(v) - t) === Math.min(...dists);
            }
          } else ok = truth[q.type] instanceof Set && truth[q.type].has(v);
          if (ok) { sp.pts += Number(q.points) || 0; sp.correct.push(q.id); }
        }
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
    weekRecap, hallEntry, hallDue
  };
// `this` is undefined in an ES module, so a Cloudflare Worker importing this
// file would crash on a bare `this`. globalThis works in every place these
// rules run: browser, node test harness, Worker.
})(typeof window !== 'undefined' ? window : globalThis);
