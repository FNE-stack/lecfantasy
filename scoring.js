// ═══════════════════════════════════════════════════════════════════════════
// scoring.js — the single source of truth for fantasy points.
//
// Loaded by BOTH the draft page and the public league page, so a score shown
// during the draft can never disagree with the standings. Pure functions, no
// DOM, no fetch — everything is passed in.
// ═══════════════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  // Points for one player-game. `s` = league.scoring.
  function gamePoints(g, s) {
    if (!g) return 0;
    let p = 0;
    p += (g.k || 0) * s.kill;
    p += (g.d || 0) * s.death;
    p += (g.a || 0) * s.assist;
    p += (g.cs || 0) * (s.cs10 || 0);
    if (g.win) p += s.win;
    if (g.penta) p += (s.pentaKill || 0) * g.penta;
    return Math.round(p * 100) / 100;
  }

  // All games grouped by player id.
  function byPlayer(games) {
    const m = new Map();
    for (const g of games || []) {
      if (!g.player) continue;
      if (!m.has(g.player)) m.set(g.player, []);
      m.get(g.player).push(g);
    }
    return m;
  }

  // Season total for one player.
  function playerTotal(games, s) {
    let t = 0;
    for (const g of games || []) t += gamePoints(g, s);
    return Math.round(t * 100) / 100;
  }

  // Who owns whom, from the draft picks. Last pick wins if duplicated (it
  // shouldn't be — the draft UI blocks it — but be defensive).
  function ownership(league) {
    const own = new Map();
    for (const p of (league.draft && league.draft.picks) || []) {
      if (p && p.player && p.manager) own.set(p.player, p.manager);
    }
    // apply approved swaps in order
    for (const sw of league.swaps || []) {
      if (!sw || !sw.manager || !sw.out || !sw.in) continue;
      if (own.get(sw.out) === sw.manager) {
        own.delete(sw.out);
        own.set(sw.in, sw.manager);
      }
    }
    return own;
  }

  // Manager rosters: { managerId: [playerId, …] }
  function rosters(league) {
    const own = ownership(league);
    const out = {};
    for (const m of league.managers || []) out[m.id] = [];
    own.forEach(function (mgr, player) {
      if (!out[mgr]) out[mgr] = [];
      out[mgr].push(player);
    });
    return out;
  }

  // Standings: [{manager, name, total, perPlayer:[{player,pts,games}]}]
  function standings(league, stats, playerIndex) {
    const s = league.scoring;
    const gp = byPlayer(stats && stats.games);
    const ros = rosters(league);
    const rows = (league.managers || []).map(function (m) {
      const ids = ros[m.id] || [];
      const perPlayer = ids.map(function (pid) {
        const games = gp.get(pid) || [];
        const meta = playerIndex ? playerIndex.get(pid) : null;
        return {
          player: pid,
          team: meta ? meta.team : '',
          role: meta ? meta.role : '',
          games: games.length,
          pts: playerTotal(games, s)
        };
      }).sort(function (a, b) { return b.pts - a.pts; });
      const total = perPlayer.reduce(function (t, r) { return t + r.pts; }, 0);
      return {
        manager: m.id, name: m.name,
        total: Math.round(total * 100) / 100,
        perPlayer: perPlayer
      };
    });
    rows.sort(function (a, b) { return b.total - a.total; });
    return rows;
  }

  // Validate a prospective pick against the league rules.
  // Returns null if legal, or a human-readable reason string.
  function pickError(league, playerIndex, managerId, playerId) {
    const own = ownership(league);
    if (own.has(playerId)) {
      const who = own.get(playerId);
      const m = (league.managers || []).find(x => x.id === who);
      return 'schon gedraftet von ' + (m ? m.name : who);
    }
    const meta = playerIndex.get(playerId);
    if (!meta) return 'unbekannter Spieler';

    const mine = [];
    own.forEach(function (mgr, pid) { if (mgr === managerId) mine.push(pid); });

    const slots = league.roster.slots || [];
    const bench = league.roster.bench || 0;
    if (mine.length >= slots.length + bench) return 'Kader voll';

    // one per role until every starting slot is filled
    const roleCount = {};
    for (const pid of mine) {
      const mm = playerIndex.get(pid);
      if (mm) roleCount[mm.role] = (roleCount[mm.role] || 0) + 1;
    }
    const need = slots.filter(r => !roleCount[r]);
    if (need.length) {
      // must still fill these roles; block a duplicate role if doing so would
      // make it impossible to complete the starting five
      const remaining = slots.length + bench - mine.length;
      if ((roleCount[meta.role] || 0) >= 1 && remaining <= need.length) {
        return 'brauchst noch: ' + need.join(', ');
      }
    }

    const maxTeam = league.roster.maxPerTeam || 99;
    let sameTeam = 0;
    for (const pid of mine) {
      const mm = playerIndex.get(pid);
      if (mm && mm.team === meta.team) sameTeam++;
    }
    if (sameTeam >= maxTeam) return 'max. ' + maxTeam + ' von ' + meta.team;

    return null;
  }

  // Whose turn is it? Snake order over managers.
  function currentPicker(league) {
    const order = (league.draft && league.draft.order) || [];
    if (!order.length) return null;
    const n = ((league.draft && league.draft.picks) || []).length;
    const slots = (league.roster.slots || []).length + (league.roster.bench || 0);
    const totalPicks = order.length * slots;
    if (n >= totalPicks) return null;
    const round = Math.floor(n / order.length);
    const idx = n % order.length;
    const snake = league.draft.snake && (round % 2 === 1);
    return order[snake ? order.length - 1 - idx : idx];
  }

  function draftProgress(league) {
    const order = (league.draft && league.draft.order) || [];
    const slots = (league.roster.slots || []).length + (league.roster.bench || 0);
    const total = order.length * slots;
    const done = ((league.draft && league.draft.picks) || []).length;
    return { done: done, total: total, round: Math.floor(done / Math.max(1, order.length)) + 1 };
  }

  global.LECScoring = {
    gamePoints, byPlayer, playerTotal, ownership, rosters, standings,
    pickError, currentPicker, draftProgress
  };
})(typeof window !== 'undefined' ? window : this);
