// ═══════════════════════════════════════════════════════════════════════════
// admin-ui.js — the admin page (#/admin). Every button is one Worker admin op;
// every op is a commit, so everything here can be undone under "Verlauf".
// Separate admin password, token kept only for this browser tab.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
'use strict';
let ctx = null, root = null, A = null, health = null, history = null, tab = 'overview', busy = false, flash = null;
const TOK = 'lf.admin';
const esc = s => window.LECUI.esc(s);
const fmt = n => window.LECUI.fmt(n);
// kept in localStorage so a reload doesn't log the admin out; the token
// itself expires after 12 h
const tokenGet = () => { try { const t = JSON.parse(localStorage.getItem(TOK) || 'null'); return t && t.exp * 1000 > Date.now() ? t.token : null; } catch (e) { return null; } };
const tokenSet = t => { try { localStorage.setItem(TOK, JSON.stringify(t)); } catch (e) {} };
const tokenDel = () => { try { localStorage.removeItem(TOK); } catch (e) {} };

async function api(path, opt) {
  opt = opt || {};
  const headers = { 'Content-Type': 'application/json' };
  const t = tokenGet();
  if (t) headers.Authorization = 'Bearer ' + t;
  let r;
  try { r = await fetch(ctx.WORKER + path, { method: opt.method || 'GET', headers, body: opt.body ? JSON.stringify(opt.body) : undefined }); }
  catch (e) { throw new Error('Worker nicht erreichbar. → Notfall-Tab'); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/admin/login') { tokenDel(); A = null; draw(); }
  if (!r.ok) throw Object.assign(new Error(data.error || 'Fehler ' + r.status), { data });
  return data;
}
async function load() {
  A = await api('/api/admin/state');
  draw();
}
async function op(body, confirmText) {
  if (confirmText && !window.confirm(confirmText)) return;
  if (busy) return;
  busy = true; draw();
  try {
    const r = await api('/api/admin/op', { method: 'POST', body });
    flash = { ok: true, text: r.message || 'erledigt' };
    await load();
  } catch (e) {
    flash = { ok: false, text: e.message };
  } finally { busy = false; draw(); }
}

const P = id => ctx.D.P.get(id);
const pname = id => (P(id) ? `${P(id).name} (${P(id).team} ${P(id).role})` : id);
const mname = id => ((A.league.managers || []).find(m => m.id === id) || {}).name || id;
const card = (t, b, r) => `<section class="card" style="margin-bottom:16px"><div class="card-h"><h2>${t}</h2>${r ? `<span class="r">${r}</span>` : ''}</div>${b}</section>`;
const btn = (label, act, data, cls) => `<button class="btn sm ${cls || ''}" data-act="${act}" ${Object.entries(data || {}).map(([k, v]) => `data-${k}="${esc(typeof v === 'string' ? v : JSON.stringify(v))}"`).join(' ')} ${busy ? 'disabled' : ''}>${label}</button>`;
const opBtn = (label, body, confirmText, cls) => btn(label, 'op', { op: body, confirm: confirmText || '' }, cls);
const mgrOptions = sel => (A.league.managers || []).map(m => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
function playerList(id, filter) {
  return `<datalist id="${id}">${ctx.D.players.players.filter(filter || (() => true)).map(p => `<option value="${esc(p.name)} · ${esc(p.team)} ${esc(p.role)}" data-id="${esc(p.id)}"></option>`).join('')}</datalist>`;
}
const pidFromInput = v => { const name = String(v || '').split(' · ')[0].trim().toLowerCase(); const p = ctx.D.players.players.find(x => x.name.toLowerCase() === name); return p ? p.id : null; };

// ── views ─────────────────────────────────────────────────────────────────
function viewLogin(err) {
  return `<div style="max-width:420px;margin:30px auto">${card('Admin-Login', `<div class="card-b">
    ${err ? `<div class="msg err">${esc(err)}</div>` : ''}
    <label>Name</label><input id="auser" autocomplete="username" value="admin" style="width:100%">
    <label>Passwort</label><input id="apw" type="password" autocomplete="current-password" style="width:100%">
    <div style="margin-top:14px"><button class="btn gold" id="alogin">Einloggen</button></div>
    <p class="muted" style="font-size:12px;margin-top:14px">Der Admin-Zugang ist getrennt von deinem Spieler-Konto.</p></div>`)}</div>`;
}

function viewOverview() {
  const v = A.validation;
  const hc = health ? health.map(c => `<div class="row" style="padding:9px 16px;border-bottom:1px solid var(--line);gap:10px">
      <span style="width:18px;color:${c.ok === true ? 'var(--win)' : c.ok === false ? 'var(--loss)' : 'var(--gold)'}">${c.ok === true ? '✓' : c.ok === false ? '✗' : '?'}</span>
      <b style="min-width:150px">${esc(c.name)}</b><span class="muted" style="font-size:13px">${esc(c.detail || '')}</span></div>`).join('')
    : '<div class="empty">prüfe …</div>';
  const issue = (x, kind) => `<div class="row" style="padding:10px 16px;border-bottom:1px solid var(--line);gap:10px;justify-content:space-between;flex-wrap:wrap">
      <span><span class="pill ${kind === 'err' ? 'live' : 'gold'}">${kind === 'err' ? 'Fehler' : 'Hinweis'}</span> ${esc(x.msg)}</span>
      ${x.fix ? opBtn('Beheben', { op: 'fix', fix: Object.assign({ force: true }, x.fix) }, 'Diese Korrektur anwenden?', 'gold') : ''}</div>`;
  const issues = v.errors.map(e => issue(e, 'err')).join('') + v.warnings.map(w => issue(w, 'warn')).join('');
  return card('System', hc, btn('Neu prüfen', 'health'))
    + card('Datenprüfung', issues || '<div class="empty" style="color:var(--win)">✓ league.json ist konsistent</div>', `${v.errors.length} Fehler · ${v.warnings.length} Hinweise`)
    + card('Schnellaktionen', `<div class="card-b" style="display:flex;flex-direction:column;gap:14px">
      <div class="row" style="flex-wrap:wrap">${btn('Stats jetzt aktualisieren', 'stats', {}, 'gold')}<span class="muted" style="font-size:12px">holt neue Spiele, Kader, Spielplan (1–3 min)</span></div>
      <div><label>Ankündigung (oben auf allen Seiten)</label><div class="row" style="flex-wrap:wrap"><input id="ann" value="${esc((A.league.announcement || {}).text || '')}" style="flex:1;min-width:200px" maxlength="280">
        ${btn('Setzen', 'announce')}${btn('Entfernen', 'announceClear')}</div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="annPush" style="width:auto"> auch als Push an alle senden ${A.pushEnabled ? '' : '<span class="pill">Push nicht eingerichtet</span>'}</label></div>
    </div>`)
    + (A.privateData ? '' : `<div class="note">⚠️ Die Liga-Daten liegen noch im <b>öffentlichen</b> Repo (${esc(A.dataRepo)}). Mitglieder und Picks sind dort für jeden lesbar, auch wenn die Seite sie versteckt. → Notfall-Tab: „Privates Daten-Repo".</div>`);
}

function viewDraft() {
  const L = A.league, d = L.draft, st = window.LECScoring.draftStatus(L);
  const sbtn = (s, label) => opBtn(label, { op: 'setStatus', status: s }, `Status auf „${label}" setzen?`, st === s ? 'gold' : '');
  const order = (d.order || []).map((id, i) => `<div class="row" style="padding:8px 16px;border-bottom:1px solid var(--line);gap:10px">
      <span class="rank" style="width:28px;font-size:16px">${i + 1}</span><b style="flex:1">${esc(mname(id))}</b>
      ${btn('↑', 'move', { i, dir: -1 })}${btn('↓', 'move', { i, dir: 1 })}</div>`).join('');
  const picks = (d.picks || []).map((p, i) => `<tr><td class="rank" style="width:36px;font-size:15px">${i + 1}</td>
      <td><select data-act="pickMgr" data-i="${i}">${mgrOptions(p.manager)}</select></td>
      <td class="fill"><b>${esc(pname(p.player))}</b> ${p.by ? `<span class="pill">${esc(p.by)}</span>` : ''}</td>
      <td class="num" style="white-space:nowrap">${btn('Ändern', 'replace', { i })} ${opBtn('✕', { op: 'removePick', index: i }, `Pick #${i + 1} entfernen? Alle späteren Züge rutschen eins nach vorn.`)}</td></tr>`).join('');
  const t = d.timer || { mode: 'off', seconds: 90 };
  return card('Status', `<div class="card-b row" style="flex-wrap:wrap">${sbtn('lobby', 'Anmeldung')}${sbtn('live', 'Draft läuft')}${sbtn('done', 'Gesperrt')}
      <span class="muted" style="font-size:13px">${A.progress.done}/${A.progress.total} Picks${A.onTheClock ? ` · am Zug: <b>${esc(mname(A.onTheClock))}</b>` : ''}</span></div>`)
    + card('Eingreifen', `<div class="card-b" style="display:flex;flex-direction:column;gap:12px">
        <div><label>Pick setzen (z. B. wenn bei jemandem der Pick nicht ging)</label>
          <div class="row" style="flex-wrap:wrap"><select id="pfMgr"><option value="">— wer am Zug ist —</option>${mgrOptions('')}</select>
          <input id="pfPlayer" list="plAll" placeholder="Spieler …" style="flex:1;min-width:180px">${playerList('plAll')}
          <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="pfForce" style="width:auto"> Regeln ignorieren</label>
          ${btn('Pick setzen', 'pickFor', {}, 'gold')}</div></div>
        <div class="row" style="flex-wrap:wrap">${opBtn('Letzten Pick rückgängig', { op: 'undoPick' }, 'Letzten Pick rückgängig machen?')}
          ${btn('Draft zurücksetzen…', 'reset')}</div></div>`)
    + `<div class="grid g-2">` + card('Reihenfolge', order + `<div class="card-b row" style="flex-wrap:wrap">${btn('Speichern', 'saveOrder', {}, 'gold')}${opBtn('Auslosen', { op: 'shuffleOrder' }, 'Reihenfolge zufällig auslosen?')}
        ${opBtn(d.snake ? 'Snake: an' : 'Snake: aus', { op: 'setSnake', snake: !d.snake })}</div>`, (d.picks || []).length ? 'nach Draftbeginn nur mit Bestätigung' : '')
    + card('Pick-Timer', `<div class="card-b"><div class="row" style="flex-wrap:wrap"><select id="tMode">${['off', 'soft', 'auto'].map(m => `<option value="${m}" ${t.mode === m ? 'selected' : ''}>${{ off: 'aus', soft: 'nur Anzeige', auto: 'Auto-Pick' }[m]}</option>`).join('')}</select>
        <input id="tSec" type="number" min="15" max="3600" value="${t.seconds || 90}" style="width:100px"> s ${btn('Speichern', 'timer', {}, 'gold')}</div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">Auto-Pick nimmt zuerst die ★ Watchlist des Managers, sonst den besten Verfügbaren nach Punkten.</p></div>`) + '</div>'
    + card('Alle Picks', picks ? `<table><tbody>${picks}</tbody></table>` : '<div class="empty">noch keine Picks</div>');
}

function viewMembers() {
  const inv = A.invite;
  const link = inv ? `${location.origin}${location.pathname}#/join/${inv.code}` : '';
  const rows = A.members.map(m => `<tr><td class="fill"><b>${esc(m.name)}</b><div class="dim" style="font-size:11px">${m.joined ? 'seit ' + new Date(m.joined).toLocaleDateString('de-DE') : ''}</div></td>
      <td class="hide-s">${m.hasPassword ? '<span class="pill teal">Passwort ✓</span>' : '<span class="pill live">kein Passwort</span>'}</td>
      <td class="num hide-s">${m.sessions} Geräte</td><td class="num hide-s">${m.push ? '🔔 ' + m.push : ''}</td>
      <td class="num" style="white-space:nowrap">${btn('Umbenennen', 'rename', { id: m.id })} ${btn('Passwort', 'setpw', { id: m.id })} ${opBtn('Abmelden', { op: 'kick', manager: m.id }, `${m.name} überall abmelden?`)} ${btn('Entfernen', 'remove', { id: m.id })}</td></tr>`).join('');
  return card('Einladungslink', `<div class="card-b">${inv ? `<div class="row" style="flex-wrap:wrap"><input id="invLink" value="${esc(link)}" readonly style="flex:1;min-width:240px">${btn('Kopieren', 'copy', {}, 'gold')}
        ${btn('Neuen Link erzeugen', 'invite')}</div><p class="muted" style="font-size:12px;margin:10px 0 0">Ein neuer Link macht den alten ungültig. Beitreten geht nur, solange der Status „Anmeldung" ist.</p>`
      : `<div class="row">${btn('Einladungslink erzeugen', 'invite', {}, 'gold')}</div>`}</div>`, `${A.members.length} / ${A.capacity ?? '?'} Plätze`)
    + card('Mitglieder', rows ? `<table><tbody>${rows}</tbody></table>` : '<div class="empty">noch niemand</div>', opBtn('Alle abmelden', { op: 'kick' }, 'Wirklich ALLE überall abmelden?'))
    + card('Mitglied hinzufügen', `<div class="card-b row" style="flex-wrap:wrap"><input id="nmName" placeholder="Name" maxlength="24"><input id="nmPw" type="password" placeholder="Passwort (optional)">${btn('Hinzufügen', 'addMember', {}, 'gold')}</div>`);
}

function viewPoints() {
  const L = A.league;
  const adj = (L.adjustments || []).map((a, i) => `<tr><td><b>${esc(mname(a.manager))}</b></td><td class="num pts">${a.pts > 0 ? '+' : ''}${fmt(a.pts)}</td>
      <td class="fill muted">${esc(a.reason || '')}</td><td class="num">${opBtn('✕', { op: 'removeAdjust', index: i }, 'Korrektur entfernen?')}</td></tr>`).join('');
  const sw = (L.swaps || []).map((s, i) => `<tr><td><b>${esc(mname(s.manager))}</b></td><td class="fill">${esc(pname(s.out))} → ${esc(pname(s.in))}</td>
      <td class="dim">${s.at ? new Date(s.at).toLocaleDateString('de-DE') : 'rückwirkend'}</td><td class="num">${opBtn('✕', { op: 'removeSwap', index: i }, 'Wechsel entfernen?')}</td></tr>`).join('');
  const tr = (L.trades || []).map(t => `<tr><td>${esc(mname(t.from))} ↔ ${esc(mname(t.to))}</td><td class="fill">${t.give.map(pname).map(esc).join(', ')} ↔ ${t.get.map(pname).map(esc).join(', ')}</td>
      <td><span class="pill">${esc(t.status)}</span></td><td class="num" style="white-space:nowrap">${['proposed', 'agreed'].includes(t.status) ? opBtn('Durchwinken', { op: 'decideTrade', id: t.id, status: 'accepted' }) + ' ' + opBtn('Veto', { op: 'decideTrade', id: t.id, status: 'vetoed' }) : ''}</td></tr>`).join('');
  const owned = new Set(window.LECScoring.ownership(L).keys());
  return card('Punktekorrekturen', (adj ? `<table><tbody>${adj}</tbody></table>` : '') + `<div class="card-b row" style="flex-wrap:wrap">
      <select id="adjM">${mgrOptions('')}</select><input id="adjP" type="number" step="0.5" placeholder="+/- Punkte" style="width:120px"><input id="adjR" placeholder="Grund" style="flex:1;min-width:160px">${btn('Eintragen', 'adjust', {}, 'gold')}</div>`)
    + card('Spielerwechsel', (sw ? `<table><tbody>${sw}</tbody></table>` : '') + `<div class="card-b row" style="flex-wrap:wrap">
      <select id="swM">${mgrOptions('')}</select><input id="swOut" list="plOwned" placeholder="raus …" style="min-width:160px">${playerList('plOwned', p => owned.has(p.id))}
      <input id="swIn" list="plFree" placeholder="rein …" style="min-width:160px">${playerList('plFree', p => !owned.has(p.id))}${btn('Wechsel eintragen', 'swap', {}, 'gold')}</div>
      <p class="muted" style="font-size:12px;margin:0 16px 14px">Zählt ab jetzt — bisherige Punkte des Spielers bleiben beim alten Manager.</p>`)
    + card('Trades', tr ? `<table><tbody>${tr}</tbody></table>` : '<div class="empty">keine Trades</div>', (L.tradeRules || {}).enabled ? '<span class="pill teal">aktiv</span>' : '<span class="pill">deaktiviert</span>');
}

function viewStats() {
  const ov = (ctx.D.overrides && ctx.D.overrides.rows) || [];
  const ovRows = ov.map((o, i) => `<tr><td><span class="pill">${esc(o.op)}</span></td><td class="fill">${o.player ? esc(pname(o.player)) + ' · ' : ''}Spiel ${esc(o.game || (o.row && o.row.game) || '')}
      ${o.fields ? ' → ' + esc(JSON.stringify(o.fields)) : ''}</td><td class="num">${opBtn('✕', { op: 'removeOverride', index: i }, 'Korrektur entfernen?')}</td></tr>`).join('');
  const pid = statsPick;
  const games = pid ? ctx.D.stats.games.filter(g => g.player === pid).slice().reverse() : [];
  const gRows = games.map(g => `<tr><td class="dim">${new Date(g.ts).toLocaleDateString('de-DE')}</td><td>${esc(g.champ)}</td>
      <td><input data-f="k" data-g="${esc(g.game)}" value="${g.k}" style="width:52px"> / <input data-f="d" data-g="${esc(g.game)}" value="${g.d}" style="width:52px"> / <input data-f="a" data-g="${esc(g.game)}" value="${g.a}" style="width:52px"></td>
      <td><input data-f="cs" data-g="${esc(g.game)}" value="${g.cs}" style="width:66px"></td>
      <td><select data-f="win" data-g="${esc(g.game)}"><option value="1" ${g.win ? 'selected' : ''}>Sieg</option><option value="0" ${g.win ? '' : 'selected'}>Niederlage</option></select></td>
      <td class="num" style="white-space:nowrap">${btn('Speichern', 'ovSet', { game: g.game }, 'gold')} ${btn('Zeile raus', 'ovExRow', { game: g.game })} ${btn('Spiel raus', 'ovExGame', { game: g.game })}</td></tr>`).join('');
  return card('Stats-Update', `<div class="card-b row" style="flex-wrap:wrap">${btn('Jetzt aktualisieren', 'stats', {}, 'gold')}
      <input id="tour" value="${esc(A.league.tournament || 'auto')}" style="width:200px">${btn('Turnier setzen', 'tournament')}
      <span class="muted" style="font-size:12px">„auto" = neuestes LEC-Turnier · sonst z. B. lec_split_1_2027</span></div>`)
    + card('Stat-Korrekturen', ovRows ? `<table><tbody>${ovRows}</tbody></table>` : '<div class="empty">keine Korrekturen</div>', 'überleben jedes Stats-Update')
    + card('Spiel eines Spielers korrigieren', `<div class="card-b row" style="flex-wrap:wrap"><input id="stPlayer" list="plAll2" placeholder="Spieler …" value="${pid ? esc(P(pid).name + ' · ' + P(pid).team + ' ' + P(pid).role) : ''}" style="min-width:220px">${playerList('plAll2')}${btn('Spiele zeigen', 'stShow')}</div>`
      + (pid ? (gRows ? `<table class="tight"><thead><tr><th>Datum</th><th>Champ</th><th>K / D / A</th><th>CS</th><th></th><th></th></tr></thead><tbody>${gRows}</tbody></table>` : '<div class="empty">keine Spiele</div>') : ''));
}
let statsPick = null;

function viewSettings() {
  const L = A.league, s = L.scoring, r = L.roster;
  const tr = window.LECScoring.transferRules(L), win = window.LECScoring.transferWindow(L);
  const t = L.draft.timer || { mode: 'off', seconds: 90 };
  const num = (id, v, step) => `<input id="${id}" type="number" step="${step || 'any'}" value="${v}" style="width:90px">`;
  const chk = (id, on, label) => `<label style="display:flex;gap:10px;align-items:flex-start;margin:0;color:var(--text)"><input type="checkbox" id="${id}" style="width:auto;margin-top:3px" ${on ? 'checked' : ''}><span>${label}</span></label>`;
  const d = iso => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const now = new Date().toISOString();
  const winRows = (tr.windows || []).map((w, i) => {
    const state = w.from <= now && now <= w.to ? '<span class="pill teal">offen</span>' : w.to < now ? '<span class="pill">vorbei</span>' : '<span class="pill gold">kommt</span>';
    return `<tr><td>${state}</td><td class="fill"><b>${esc(w.label || 'Fenster')}</b> <span class="muted">${d(w.from)} – ${d(w.to)}</span></td>
      <td class="num">${btn('✕', 'winDel', { i })}</td></tr>`;
  }).join('');
  const status = tr.mode === 'always' ? '<span class="pill teal">immer offen</span>'
    : win.open ? `<span class="pill teal">offen bis ${d(win.current.to)}</span>`
    : win.next ? `<span class="pill gold">zu · öffnet ${d(win.next.from)}</span>` : '<span class="pill live">zu · kein Fenster eingetragen</span>';
  return card('Pick-Timer', `<div class="card-b"><div class="row" style="flex-wrap:wrap"><select id="tMode">${['off', 'soft', 'auto'].map(m => `<option value="${m}" ${t.mode === m ? 'selected' : ''}>${{ off: 'aus', soft: 'nur Anzeige', auto: 'Auto-Pick' }[m]}</option>`).join('')}</select>
        ${num('tSec', t.seconds || 90, 1)} Sekunden ${btn('Speichern', 'timer', {}, 'gold')}</div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">Auto-Pick: nach Ablauf pickt das System — zuerst der oberste freie Spieler aus der ★ Watchlist des Managers, sonst der beste Verfügbare nach Punkten.</p></div>`)
    + card('Transfers', `<div class="card-b" style="display:flex;flex-direction:column;gap:10px">
        ${chk('trOn', tr.enabled, '<b>Trades</b> zwischen Managern — die zwei Beteiligten einigen sich, fertig')}
        ${chk('trFa', tr.freeAgents, '<b>Free Agents</b> — Spieler, die niemand gedraftet hat, gegen einen eigenen tauschen')}
        <label style="margin:0">Free-Agent-Wechsel pro Manager und Woche (Mo–So, 0 = unbegrenzt) ${num('trPer', tr.perWeek, 1)}</label>
        ${chk('trRos', tr.rosterRules, 'Jede Rolle muss nach einem Transfer besetzt bleiben')}
        ${chk('trTeam', tr.teamLimit, 'Team-Limit (max. ' + r.maxPerTeam + ' pro LEC-Team) gilt auch bei Transfers <span class="muted" style="font-size:12px">— blockiert in der Praxis viele Trades</span>')}
        ${chk('trEq', tr.equalCount, 'Trades nur mit gleich vielen Spielern auf beiden Seiten')}
        ${chk('trAdm', tr.adminApproval, 'Admin muss Trades zusätzlich freigeben')}
        <div class="row" style="flex-wrap:wrap;gap:14px;margin-top:4px">
          <label style="display:flex;gap:8px;align-items:center;margin:0"><input type="radio" name="trMode" value="windows" style="width:auto" ${tr.mode !== 'always' ? 'checked' : ''}> nur in Transferfenstern</label>
          <label style="display:flex;gap:8px;align-items:center;margin:0"><input type="radio" name="trMode" value="always" style="width:auto" ${tr.mode === 'always' ? 'checked' : ''}> immer</label></div>
        <div>${btn('Transfer-Regeln speichern', 'trades', {}, 'gold')}</div></div>`, status)
    + card('Transferfenster', (winRows ? `<table><tbody>${winRows}</tbody></table>` : '<div class="empty">Noch kein Fenster — Transfers sind zu, bis du eins einträgst.</div>')
      + `<div class="card-b row" style="flex-wrap:wrap;border-top:1px solid var(--line)">
        <input id="wLabel" placeholder="Name, z. B. Winter-Transferfenster" maxlength="40" style="flex:1;min-width:180px">
        <label style="margin:0">von <input id="wFrom" type="date" style="width:160px"></label><label style="margin:0">bis <input id="wTo" type="date" style="width:160px"></label>
        ${btn('Fenster hinzufügen', 'winAdd', {}, 'gold')}</div>
        <p class="muted" style="font-size:12px;margin:0 16px 14px">Trag hier die Zeiträume ein, in denen laut LEC-Regelwerk Transfers erlaubt sind (bzw. was ihr absprecht). Von 00:00 bis 23:59 Uhr.</p>`)
    + card('Liga', `<div class="card-b row" style="flex-wrap:wrap"><input id="lgName" value="${esc(L.name || '')}" style="flex:1;min-width:200px" maxlength="40">${btn('Name speichern', 'name')}</div>`)
    + card('Punkte pro Spiel', `<div class="card-b"><div class="row" style="flex-wrap:wrap;gap:14px">
        <label>Kill ${num('sK', s.kill)}</label><label>Tod ${num('sD', s.death)}</label><label>Assist ${num('sA', s.assist)}</label><label>CS ${num('sC', s.cs10, '0.005')}</label><label>Sieg ${num('sW', s.win)}</label></div>
        <div style="margin-top:12px">${btn('Punkte speichern', 'scoring', {}, 'gold')} <span class="muted" style="font-size:12px">wirkt rückwirkend auf alle Spiele</span></div></div>`)
    + card('Kader', `<div class="card-b row" style="flex-wrap:wrap;gap:14px"><span class="muted">Rollen: ${esc(r.slots.join(', '))}</span><label>Bank ${num('rB', r.bench, 1)}</label><label>max. pro Team ${num('rM', r.maxPerTeam, 1)}</label>${btn('Speichern', 'roster', {}, 'gold')}</div>`)
    + card('Haupttabelle', `<div class="card-b row">${opBtn('Gesamtpunkte', { op: 'setStandingsMode', mode: 'points' }, '', (L.standingsMode || 'points') === 'points' ? 'gold' : '')}${opBtn('Head-to-Head', { op: 'setStandingsMode', mode: 'h2h' }, '', L.standingsMode === 'h2h' ? 'gold' : '')}</div>`);
}

function viewHistory() {
  if (!history) return card('Verlauf', '<div class="empty">lade …</div>');
  return card('Verlauf von league.json', '<table><tbody>' + history.map((c, i) => `<tr><td class="dim" style="white-space:nowrap">${new Date(c.date).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td class="fill">${esc(c.message)}</td><td class="dim hide-s">${esc(c.short)}</td>
      <td class="num">${i === 0 ? '<span class="pill teal">aktuell</span>' : opBtn('Wiederherstellen', { op: 'restore', sha: c.sha, force: true }, `Liga auf den Stand „${c.message}" (${c.short}) zurücksetzen? Das ist selbst wieder rückgängig machbar.`)}</td></tr>`).join('') + '</tbody></table>',
    'jede Änderung ist ein Eintrag — alles ist rückgängig machbar');
}

function viewRaw() {
  return card('league.json direkt bearbeiten', `<div class="card-b">
      <p class="muted" style="font-size:13px;margin-top:0">Letzter Ausweg. Wird vor dem Speichern geprüft; kaputte Daten nur mit „trotzdem speichern". Jeder Stand bleibt im Verlauf.</p>
      <textarea id="raw" spellcheck="false" style="width:100%;height:420px;font:12px/1.5 ui-monospace,Consolas,monospace;background:var(--bg-2);color:var(--text);border:1px solid var(--line-2);border-radius:6px;padding:12px">${esc(JSON.stringify(A.league, null, 2))}</textarea>
      <div class="row" style="margin-top:10px;flex-wrap:wrap">${btn('Prüfen', 'rawCheck')}${btn('Speichern', 'rawSave', {}, 'gold')}
        <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="rawForce" style="width:auto"> trotzdem speichern</label></div>
      <div id="rawMsg" style="margin-top:10px"></div></div>`);
}

function viewEmergency() {
  const repo = A.dataRepo;
  const path = A.privateData ? 'league.json' : 'data/league.json';
  return card('Wenn etwas schiefgeht', `<div class="card-b muted" style="line-height:1.8">
    <b style="color:var(--text)">Falscher Pick / jemand kann nicht picken</b> → Draft-Tab: „Pick setzen" (für wen gerade dran ist) oder „Ändern" / „Letzten Pick rückgängig".<br>
    <b style="color:var(--text)">Passwort vergessen</b> → Mitglieder: „Passwort" setzen und dem Spieler sagen.<br>
    <b style="color:var(--text)">Irgendwas ist kaputt / falsch geklickt</b> → Verlauf: einen Stand vor dem Fehler wiederherstellen.<br>
    <b style="color:var(--text)">Falsche Stats</b> → Stats: Spiel des Spielers korrigieren (bleibt auch nach Updates).<br>
    <b style="color:var(--text)">Worker antwortet nicht</b> → <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener">Cloudflare-Dashboard</a> → Workers → lecfantasy-draft → Logs. Neu deployen: <code>bash worker/deploy.sh</code>.<br>
    <b style="color:var(--text)">Alles andere versagt</b> → league.json direkt auf GitHub bearbeiten: <a href="https://github.com/${esc(repo)}/edit/main/${esc(path)}" target="_blank" rel="noopener">${esc(repo)}/${esc(path)}</a>
      · Verlauf: <a href="https://github.com/${esc(repo)}/commits/main/${esc(path)}" target="_blank" rel="noopener">alle Versionen</a>.<br>
    <b style="color:var(--text)">Admin-Passwort vergessen</b> → steht in <code>~/lecfantasy.env</code>; neu setzen: <code>npx wrangler secret put ADMIN_PASSWORD</code>.
    </div>`)
    + card('Privates Daten-Repo', `<div class="card-b muted" style="line-height:1.7">${A.privateData ? `<span class="pill teal">aktiv</span> Liga-Daten liegen privat in <b style="color:var(--text)">${esc(repo)}</b>.`
      : `Aktuell öffentlich in ${esc(repo)}. Für echte Privatsphäre: privates Repo <code>lecfantasy-data</code> anlegen, Token darauf erweitern, dann <code>DATA_REPO</code> setzen und neu deployen.`}</div>`);
}

const TABS = [['overview', 'Übersicht'], ['draft', 'Draft'], ['members', 'Mitglieder'], ['points', 'Punkte'], ['stats', 'Stats'], ['settings', 'Einstellungen'], ['history', 'Verlauf'], ['raw', 'Rohdaten'], ['emergency', 'Notfall']];
function draw() {
  if (!root) return;
  if (!tokenGet()) { root.innerHTML = viewLogin(flash && !flash.ok ? flash.text : ''); bind(); return; }
  if (!A) { root.innerHTML = '<div class="empty">lade Admin …</div>'; return; }
  const issues = A.validation.errors.length;
  const body = { overview: viewOverview, draft: viewDraft, members: viewMembers, points: viewPoints, stats: viewStats, settings: viewSettings, history: viewHistory, raw: viewRaw, emergency: viewEmergency }[tab]();
  root.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:14px">
      <div><div class="eyebrow">${esc(A.league.name || 'LEC Fantasy')} · ${{ lobby: 'Anmeldung', live: 'Draft läuft', done: 'Saison' }[window.LECScoring.draftStatus(A.league)]}</div><h1 style="font-size:40px">Admin</h1></div>
      <div class="row">${issues ? `<span class="pill live">${issues} Fehler</span>` : '<span class="pill teal">konsistent</span>'}${btn('Neu laden', 'reload')}${btn('Admin abmelden', 'alogout')}</div></div>
    <div class="chips" style="margin-bottom:16px">${TABS.map(([k, l]) => `<button class="chip ${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    ${flash ? `<div class="msg ${flash.ok ? 'ok' : 'err'}">${esc(flash.text)}</div>` : ''}${body}`;
  bind();
}

function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function bind() {
  const lb = document.getElementById('alogin');
  if (lb) {
    const go = async () => {
      try { const r = await api('/api/admin/login', { method: 'POST', body: { username: val('auser'), password: val('apw') } }); tokenSet(r); flash = null; await load(); runHealth(); }
      catch (e) { flash = { ok: false, text: e.message }; draw(); }
    };
    lb.onclick = go; document.getElementById('apw').onkeydown = e => { if (e.key === 'Enter') go(); };
    return;
  }
  root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; flash = null; if (tab === 'history') loadHistory(); draw(); });
  root.querySelectorAll('[data-act]').forEach(el => {
    const ev = el.tagName === 'SELECT' ? 'onchange' : 'onclick';
    el[ev] = () => act(el.dataset.act, el.dataset, el);
  });
}

async function runHealth() { health = null; draw(); try { health = (await api('/api/admin/health')).checks; } catch (e) { health = [{ name: 'Health', ok: false, detail: e.message }]; } draw(); }
async function loadHistory() { history = null; draw(); try { history = (await api('/api/admin/history')).commits; } catch (e) { flash = { ok: false, text: e.message }; history = []; } draw(); }
const J = s => { try { return JSON.parse(s); } catch (e) { return s; } };

async function act(a, d, el) {
  const L = A.league;
  switch (a) {
    case 'op': return op(J(d.op), d.confirm || null);
    case 'reload': flash = null; await load(); if (tab === 'overview') runHealth(); if (tab === 'history') loadHistory(); return;
    case 'alogout': tokenDel(); A = null; draw(); return;
    case 'health': return runHealth();
    case 'stats':
      try { const r = await api('/api/admin/stats', { method: 'POST', body: {} }); flash = { ok: true, text: r.message }; } catch (e) { flash = { ok: false, text: e.message }; }
      return draw();
    case 'announce': {
      const text = val('ann').trim();
      await op({ op: 'announce', text });
      if (text && document.getElementById('annPush') && document.getElementById('annPush').checked) {
        try { const r = await api('/api/admin/broadcast', { method: 'POST', body: { text } }); flash = { ok: true, text: `Ankündigung gesetzt · Push an ${r.sent || 0} Geräte` }; } catch (e) { flash = { ok: false, text: e.message }; }
        draw();
      }
      return;
    }
    case 'announceClear': return op({ op: 'announce', text: '' });
    case 'pickFor': {
      const player = pidFromInput(val('pfPlayer'));
      if (!player) { flash = { ok: false, text: 'Spieler aus der Liste wählen' }; return draw(); }
      const force = document.getElementById('pfForce').checked;
      return op({ op: 'pickFor', manager: val('pfMgr') || null, player, force }, `${pname(player)} für ${val('pfMgr') ? mname(val('pfMgr')) : 'wer am Zug ist'} picken?${force ? ' (Regeln ignoriert)' : ''}`);
    }
    case 'reset': {
      const t = window.prompt('Draft zurücksetzen: ALLE Picks, Wechsel, Trades und Punktekorrekturen werden gelöscht, zurück zur Anmeldung. Mitglieder bleiben. Zum Bestätigen RESET eintippen.');
      if (t === 'RESET') return op({ op: 'resetDraft' });
      return;
    }
    case 'move': {
      const i = +d.i, j = i + +d.dir, o = L.draft.order.slice();
      if (j < 0 || j >= o.length) return;
      [o[i], o[j]] = [o[j], o[i]];
      L.draft.order = o; draw(); return;
    }
    case 'saveOrder': return op({ op: 'setOrder', order: L.draft.order, force: true }, (L.draft.picks || []).length ? 'Es gibt schon Picks — Reihenfolge trotzdem ändern? Alle folgenden Züge verschieben sich.' : null);
    case 'timer': return op({ op: 'setTimer', mode: val('tMode'), seconds: +val('tSec') });
    case 'pickMgr': return op({ op: 'setPickManager', index: +d.i, manager: el.value }, `Pick #${+d.i + 1} gehört jetzt ${mname(el.value)}?`);
    case 'replace': {
      const v = window.prompt(`Pick #${+d.i + 1} ändern zu (Spielername):`, '');
      if (!v) return;
      const player = pidFromInput(v) || (ctx.D.players.players.find(p => p.name.toLowerCase() === v.trim().toLowerCase()) || {}).id;
      if (!player) { flash = { ok: false, text: 'Spieler nicht gefunden: ' + v }; return draw(); }
      return op({ op: 'replacePick', index: +d.i, player });
    }
    case 'copy': {
      const inp = document.getElementById('invLink');
      try { await navigator.clipboard.writeText(inp.value); flash = { ok: true, text: 'Link kopiert — schick ihn rum.' }; } catch (e) { inp.select(); document.execCommand('copy'); flash = { ok: true, text: 'Link kopiert.' }; }
      return draw();
    }
    case 'invite': {
      if (A.invite && !window.confirm('Neuen Link erzeugen? Der alte funktioniert dann nicht mehr.')) return;
      try { await api('/api/admin/invite', { method: 'POST', body: {} }); flash = { ok: true, text: 'Neuer Einladungslink erzeugt.' }; await load(); } catch (e) { flash = { ok: false, text: e.message }; draw(); }
      return;
    }
    case 'rename': { const n = window.prompt('Neuer Name für ' + mname(d.id) + ':', mname(d.id)); if (n) return op({ op: 'renameManager', manager: d.id, name: n }); return; }
    case 'setpw': { const pw = window.prompt('Neues Passwort für ' + mname(d.id) + ' (min. 6 Zeichen). Er wird überall abgemeldet.'); if (pw) return op({ op: 'setPassword', manager: d.id, password: pw }); return; }
    case 'remove': {
      const picks = (L.draft.picks || []).filter(p => p.manager === d.id).length;
      if (!window.confirm(`${mname(d.id)} entfernen?${picks ? ` Seine ${picks} Picks werden gelöscht.` : ''}`)) return;
      return op({ op: 'removeManager', manager: d.id, force: !!picks });
    }
    case 'addMember': return op({ op: 'addManager', name: val('nmName'), password: val('nmPw') || undefined });
    case 'adjust': return op({ op: 'adjust', manager: val('adjM'), pts: parseFloat(String(val('adjP')).replace(',', '.')), reason: val('adjR') });
    case 'swap': {
      const out = pidFromInput(val('swOut')), inn = pidFromInput(val('swIn'));
      if (!out || !inn) { flash = { ok: false, text: 'Beide Spieler aus der Liste wählen' }; return draw(); }
      return op({ op: 'addSwap', manager: val('swM'), out, in: inn }, `${mname(val('swM'))}: ${pname(out)} → ${pname(inn)}?`);
    }
    case 'tournament': return op({ op: 'setTournament', tournament: val('tour') });
    case 'stShow': statsPick = pidFromInput(val('stPlayer')); return draw();
    case 'ovSet': {
      const f = {};
      root.querySelectorAll(`[data-g="${CSS.escape(d.game)}"]`).forEach(x => { f[x.dataset.f] = x.dataset.f === 'win' ? x.value === '1' : Number(x.value); });
      return op({ op: 'override', entry: { op: 'set', game: d.game, player: statsPick, fields: f } }, 'Werte für dieses Spiel überschreiben?');
    }
    case 'ovExRow': return op({ op: 'override', entry: { op: 'exclude', game: d.game, player: statsPick } }, 'Diese Spieler-Zeile aus der Wertung nehmen?');
    case 'ovExGame': return op({ op: 'override', entry: { op: 'exclude', game: d.game } }, 'Das ganze Spiel (alle 10 Spieler) aus der Wertung nehmen?');
    case 'name': return op({ op: 'setName', name: val('lgName') });
    case 'scoring': return op({ op: 'setScoring', scoring: { kill: +val('sK'), death: +val('sD'), assist: +val('sA'), cs10: +val('sC'), win: +val('sW') } }, 'Punkte ändern? Gilt rückwirkend für alle Spiele.');
    case 'roster': return op({ op: 'setRoster', roster: { slots: L.roster.slots, bench: +val('rB'), maxPerTeam: +val('rM') }, force: true }, (L.draft.picks || []).length ? 'Kaderregeln nach Draftbeginn ändern?' : null);
    case 'trades': case 'winAdd': case 'winDel': {
      const cur = window.LECScoring.transferRules(L);
      const g = id => document.getElementById(id);
      const rules = a === 'trades' ? {
        enabled: g('trOn').checked, freeAgents: g('trFa').checked, perWeek: Math.max(0, parseInt(val('trPer'), 10) || 0),
        rosterRules: g('trRos').checked, teamLimit: g('trTeam').checked, equalCount: g('trEq').checked, adminApproval: g('trAdm').checked,
        mode: (root.querySelector('input[name="trMode"]:checked') || {}).value || 'windows', windows: cur.windows,
      } : Object.assign({}, cur);
      if (a === 'winAdd') {
        if (!val('wFrom') || !val('wTo')) { flash = { ok: false, text: 'Von und Bis angeben' }; return draw(); }
        rules.windows = (cur.windows || []).concat({ from: new Date(val('wFrom') + 'T00:00:00').toISOString(), to: new Date(val('wTo') + 'T23:59:59').toISOString(), label: val('wLabel') });
      }
      if (a === 'winDel') rules.windows = (cur.windows || []).filter((_, k) => k !== +d.i);
      return op({ op: 'setTradeRules', rules }, a === 'winDel' ? 'Fenster löschen?' : null);
    }
    case 'rawCheck': case 'rawSave': {
      let obj;
      try { obj = JSON.parse(val('raw')); } catch (e) { document.getElementById('rawMsg').innerHTML = `<div class="msg err">Kein gültiges JSON: ${esc(e.message)}</div>`; return; }
      const v = window.LECScoring.validateLeague(obj, new Map(ctx.D.players.players.map(p => [p.id, p])));
      const msg = v.errors.length ? `<div class="msg err">${v.errors.map(e => esc(e.msg)).join('<br>')}</div>` : `<div class="msg ok">✓ gültig${v.warnings.length ? ' · ' + v.warnings.length + ' Hinweise' : ''}</div>`;
      document.getElementById('rawMsg').innerHTML = msg;
      if (a === 'rawSave') return op({ op: 'setRaw', league: obj, force: document.getElementById('rawForce').checked }, 'league.json mit diesem Inhalt überschreiben?');
      return;
    }
  }
}

window.LECAdmin = {
  render(container, c) {
    ctx = c;
    const first = root !== container;
    root = container;
    if (first && tokenGet()) { load().then(runHealth).catch(e => { flash = { ok: false, text: e.message }; draw(); }); }
    draw();
  },
  leave() { root = null; },
};
})();
