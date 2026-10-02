// ═══════════════════════════════════════════════════════════════════════════
// common.js — data loading and display helpers shared by every page.
//
// scoring.js owns the RULES; this file owns how things LOOK: loading the data
// files, and turning a player id (a 17-digit lolesports number) into a name,
// team logo, photo and champion icon. Kept separate so the Worker, which
// imports scoring.js, never drags in DOM code.
// ═══════════════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => (Math.round((n || 0) * 10) / 10)
    .toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  async function getJson(path, optional) {
    try {
      // minute-granular cache-bust: fresh commits show up without hard reload
      const r = await fetch(path + '?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' });
      if (!r.ok) throw new Error(path + ' ' + r.status);
      return await r.json();
    } catch (e) {
      if (optional) return null;
      throw e;
    }
  }

  // Points table used wherever no league is loaded (logged-out pages).
  const DEFAULT_SCORING = { kill: 3, death: -1, assist: 1.5, cs10: 0.02, win: 2 };

  // All PUBLIC data (LEC teams, players, stats, schedule). The league itself -
  // members, picks - is private and comes from the Worker after login, so it
  // is not loaded here; the app sets D.league once it has it.
  async function load() {
    const [players, teams, stats, champs, schedule, overrides, season, standings] = await Promise.all([
      getJson('data/players.json', true),
      getJson('data/teams.json', true),
      getJson('data/stats.json', true),
      getJson('data/champions.json', true),
      getJson('data/schedule.json', true),
      getJson('data/overrides.json', true),
      getJson('data/season.json', true),
      getJson('data/standings.json', true),
    ]);
    // admin stat corrections apply everywhere the stats are shown
    if (stats && global.LECScoring) stats.games = global.LECScoring.applyOverrides(stats.games, overrides);
    const P = new Map(), T = new Map();
    for (const p of (players && players.players) || []) P.set(p.id, p);
    // players who left their team mid-season keep a name for their old points
    for (const p of (players && players.former) || []) if (!P.has(p.id)) P.set(p.id, p);
    for (const t of (teams && teams.teams) || []) T.set(t.code, t);
    return {
      league: null, overrides: overrides || { rows: [] }, players: players || { players: [] }, teams: teams || { teams: [] },
      stats: stats || { games: [] }, champs: champs || { names: {} },
      schedule: schedule || { events: [] }, season: season || { tournaments: [] }, standings: standings || { tournaments: {} }, P, T,
    };
  }

  function teamLogo(D, code, size) {
    const t = D.T.get(code);
    size = size || 18;
    if (!t || !t.logo) return `<span class="tcode">${esc(code || '')}</span>`;
    return `<img class="tlogo" src="${esc(t.logo)}" alt="${esc(code)}" title="${esc(t.name)}"`
         + ` width="${size}" height="${size}" loading="lazy">`;
  }

  function champIcon(D, champ, size) {
    if (!champ) return '';
    size = size || 22;
    const name = (D.champs.names || {})[champ] || champ;
    if (!D.champs.version) return `<span class="pill">${esc(name)}</span>`;
    const src = `https://ddragon.leagueoflegends.com/cdn/${D.champs.version}/img/champion/${encodeURIComponent(champ)}.png`;
    return `<img class="cicon" src="${src}" alt="${esc(name)}" title="${esc(name)}"`
         + ` width="${size}" height="${size}" loading="lazy">`;
  }

  function playerName(D, id) {
    const p = D.P.get(id);
    return p ? p.name : String(id || '');
  }

  // Logo + role + IGN (+ real name). `opts.photo` adds the headshot, and
  // `opts.link` makes it clickable for pages that show a player card.
  function playerCell(D, id, opts) {
    opts = opts || {};
    const p = D.P.get(id);
    if (!p) return `<span class="pname">${esc(id)}</span>`;
    const photo = opts.photo
      ? (p.photo ? `<img class="ph" src="${esc(p.photo)}" alt="" loading="lazy">`
                 : '<span class="ph ph-none"></span>')
      : '';
    const real = opts.real && p.realName ? ` <span class="real">${esc(p.realName)}</span>` : '';
    const former = p.former ? ' <span class="pill">ehem.</span>' : '';
    const name = `<span class="pname">${esc(p.name)}</span>`;
    const inner = `${photo}${teamLogo(D, p.team)} <span class="role">${esc(p.role || '?')}</span> `
                + (opts.link ? `<a href="#" class="plink" data-pid="${esc(p.id)}">${name}</a>` : name)
                + real + former;
    return `<span class="pcell">${inner}</span>`;
  }

  // Per-player season aggregates from the raw game rows.
  function playerSeason(D, id) {
    const s = (D.league && D.league.scoring) || DEFAULT_SCORING;
    const rows = (D.stats.games || []).filter(g => g.player === id);
    const sum = { games: rows.length, wins: 0, k: 0, d: 0, a: 0, cs: 0, pts: 0 };
    for (const g of rows) {
      sum.k += g.k; sum.d += g.d; sum.a += g.a; sum.cs += g.cs;
      if (g.win) sum.wins++;
      sum.pts += global.LECScoring.gamePoints(g, s);
    }
    sum.pts = Math.round(sum.pts * 100) / 100;
    sum.avg = rows.length ? sum.pts / rows.length : 0;
    sum.rows = rows.sort((a, b) => (a.ts + a.n).localeCompare(b.ts + b.n));
    return sum;
  }


  global.LECUI = { DEFAULT_SCORING, esc, fmt, getJson, load, teamLogo, champIcon, playerName,
                   playerCell, playerSeason };
})(typeof window !== 'undefined' ? window : globalThis);
