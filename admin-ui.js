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
const S = window.LECScoring;
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
  const picks = (d.picks || []).map((p, i) => `<div style="padding:10px 16px;border-bottom:1px solid var(--line)">
      <div class="row" style="gap:10px;min-width:0"><span class="rank" style="width:28px;font-size:15px">${i + 1}</span><b style="flex:1;min-width:0;overflow-wrap:anywhere">${esc(pname(p.player))}</b>${p.by ? `<span class="pill">${esc(p.by)}</span>` : ''}</div>
      <div class="row" style="gap:6px;margin:8px 0 0 38px;flex-wrap:wrap"><select data-act="pickMgr" data-i="${i}" style="flex:1;min-width:120px">${mgrOptions(p.manager)}</select>${btn('Ändern', 'replace', { i })}${opBtn('✕', { op: 'removePick', index: i }, `Pick #${i + 1} entfernen? Alle späteren Züge rutschen eins nach vorn.`)}</div></div>`).join('');
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
    + card('Alle Picks', picks || '<div class="empty">noch keine Picks</div>');
}

function viewMembers() {
  const inv = A.invite;
  const link = inv ? `${location.origin}${location.pathname}#/join/${inv.code}` : '';
  const rows = A.members.map(m => `<div style="padding:12px 16px;border-bottom:1px solid var(--line)">
      <div class="row" style="gap:8px;flex-wrap:wrap"><b style="font-size:15px">${esc(m.name)}</b>${m.hasPassword ? '<span class="pill teal">Passwort ✓</span>' : '<span class="pill live">kein Passwort</span>'}</div>
      <div class="dim" style="font-size:12px;margin:3px 0 8px">${m.joined ? 'seit ' + new Date(m.joined).toLocaleDateString('de-DE') + ' · ' : ''}${m.sessions} Geräte${m.push ? ' · 🔔 ' + m.push : ''}</div>
      <div class="row" style="gap:6px;flex-wrap:wrap">${btn('Umbenennen', 'rename', { id: m.id })}${btn('Passwort', 'setpw', { id: m.id })}${opBtn('Abmelden', { op: 'kick', manager: m.id }, `${m.name} überall abmelden?`)}${btn('Entfernen', 'remove', { id: m.id })}</div></div>`).join('');
  return card('Einladungslink', `<div class="card-b">${inv ? `<div class="row" style="flex-wrap:wrap"><input id="invLink" value="${esc(link)}" readonly style="flex:1;min-width:240px">${btn('Kopieren', 'copy', {}, 'gold')}
        ${btn('Neuen Link erzeugen', 'invite')}</div><p class="muted" style="font-size:12px;margin:10px 0 0">Ein neuer Link macht den alten ungültig. Beitreten geht nur, solange der Status „Anmeldung" ist.</p>`
      : `<div class="row">${btn('Einladungslink erzeugen', 'invite', {}, 'gold')}</div>`}</div>`, `${A.members.length} / ${A.capacity ?? '?'} Plätze`)
    + card('Mitglieder', rows ? rows : '<div class="empty">noch niemand</div>', opBtn('Alle abmelden', { op: 'kick' }, 'Wirklich ALLE überall abmelden?'))
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
    + card('Trades', tr ? `<table><tbody>${tr}</tbody></table>` : '<div class="empty">keine Trades</div>', (L.tradeRules || {}).enabled ? '<span class="pill teal">aktiv</span>' : '<span class="pill">deaktiviert</span>')
    + viewHallAdmin();
}
function viewHallAdmin() {
  const hall = A.league.hall || {};
  const rows = Object.entries(hall).map(([k, e]) => `<tr><td><b>${esc(k)}</b></td><td class="fill">${esc(((e.table || [])[0] || {}).name || '—')}</td><td class="dim">${e.at ? new Date(e.at).toLocaleDateString('de-DE') : ''}</td>
      <td class="num">${btn('✕', 'hall', { split: k, mode: 'delete' })}</td></tr>`).join('');
  const splits = ((ctx.D.season || {}).tournaments || []).map(t => t.slug);
  return card('Ruhmeshalle', (rows ? `<table><tbody>${rows}</tbody></table>` : '<div class="empty">noch leer</div>')
    + `<div class="card-b row" style="flex-wrap:wrap"><select id="hallSplit">${splits.map(x => `<option>${esc(x)}</option>`).join('')}</select>${btn('Eintragen / neu berechnen', 'hall', { mode: 'build' }, 'gold')}</div>
    <p class="muted" style="font-size:12px;margin:0 16px 14px">Passiert automatisch 12 h nach dem letzten Spiel eines Splits (nur Splits, die die Liga gespielt hat). Hier z. B. nach einer Stat-Korrektur neu berechnen.</p>`);
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
  const tr = window.LECScoring.transferRules(L), win = window.LECScoring.transferWindow(L), wv = window.LECScoring.waiverRules(L);
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
    + card('Draft-Termin', (() => {
        const d0 = L.draft || {};
        const local = d0.scheduledAt ? new Date(new Date(d0.scheduledAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
        return `<div class="card-b" style="display:flex;flex-direction:column;gap:10px">
          <div class="row" style="flex-wrap:wrap"><label style="margin:0">Termin <input id="dAt" type="datetime-local" value="${local}" style="width:220px"></label>
            <label style="margin:0">Erinnerung ${num('dRem', d0.reminderMinutes ?? 60, 5)} Minuten vorher (Push, 0 = keine)</label></div>
          ${chk('dAuto', d0.autoStart, 'Draft zum Termin <b>automatisch starten</b> (sonst startest du ihn hier im Admin)')}
          <div class="row">${btn('Termin speichern', 'schedule', {}, 'gold')}${d0.scheduledAt ? btn('Termin entfernen', 'scheduleClear') : ''}</div>
          <p class="muted" style="font-size:12px;margin:0">Alle sehen einen Countdown auf der Übersicht und im Draft.</p></div>`;
      })(), (L.draft || {}).scheduledAt ? '<span class="pill gold">' + new Date(L.draft.scheduledAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) + '</span>' : '')
    + card('Transfers', `<div class="card-b" style="display:flex;flex-direction:column;gap:10px">
        ${chk('trOn', tr.enabled, '<b>Trades</b> zwischen Managern — die zwei Beteiligten einigen sich, fertig')}
        ${chk('trFa', tr.freeAgents, '<b>Free Agents</b> an — Spieler, die niemand gedraftet hat, gegen einen eigenen tauschen')}
        <div style="padding:10px 12px;border:1px solid var(--line);border-radius:6px;display:flex;flex-direction:column;gap:8px">
          <div class="row" style="flex-wrap:wrap;gap:14px">
            <label style="display:flex;gap:8px;align-items:center;margin:0;color:var(--text)"><input type="radio" name="faMode" value="instant" style="width:auto" ${tr.faMode !== 'waiver' ? 'checked' : ''}> <span><b>Sofort</b> — wer zuerst klickt</span></label>
            <label style="display:flex;gap:8px;align-items:center;margin:0;color:var(--text)"><input type="radio" name="faMode" value="waiver" style="width:auto" ${tr.faMode === 'waiver' ? 'checked' : ''}> <span><b>Waiver</b> — Ansprüche sammeln, zu festen Zeiten entscheiden</span></label></div>
          <div><span class="muted" style="font-size:12px">Waiver-Tage (deutsche Zeit)</span><div class="row" style="flex-wrap:wrap;gap:10px;margin-top:4px">
            ${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((n, i) => `<label style="display:flex;gap:5px;align-items:center;margin:0;color:var(--text)"><input type="checkbox" data-wday="${i + 1}" style="width:auto" ${(wv.days || []).includes(i + 1) ? 'checked' : ''}>${n}</label>`).join('')}</div></div>
          <div class="row" style="flex-wrap:wrap;gap:14px"><label style="margin:0">um <input id="wvTime" type="time" value="${esc(wv.time || '03:00')}" style="width:150px"> Uhr</label>
            <label style="margin:0">Reihenfolge <select id="wvOrder"><option value="reverse" ${wv.order !== 'rolling' ? 'selected' : ''}>Tabellenletzter zuerst</option><option value="rolling" ${wv.order === 'rolling' ? 'selected' : ''}>rotierend (wer bekommt, geht ans Ende)</option><option value="faab" ${wv.order === 'faab' ? 'selected' : ''}>FAAB — geheime Gebote, höchstes gewinnt</option></select></label></div>
          <div class="row" style="flex-wrap:wrap;gap:12px"><span class="muted" style="font-size:12px">FAAB-Budget</span>${num('fBud', (L.faab || {}).budget || 100, 1)}
            ${chk('fReset', (L.faab || {}).resetEachSplit, 'pro Split neu')}${btn('Budget speichern', 'faab')}</div>
          ${tr.faMode === 'waiver' ? `<div class="row" style="flex-wrap:wrap"><span class="muted" style="font-size:12px">Nächster Lauf: <b style="color:var(--text)">${A.nextWaiver ? new Date(A.nextWaiver).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</b></span>${opBtn('Waiver jetzt ausführen', { op: 'runWaivers' }, 'Alle offenen Ansprüche jetzt entscheiden?')}</div>` : ''}
        </div>
        <label style="margin:0">Free-Agent-Wechsel pro Manager und Woche (Mo–So, 0 = unbegrenzt) ${num('trPer', tr.perWeek, 1)}</label>
        ${chk('trRos', tr.rosterRules, 'Jede Rolle muss nach einem Transfer besetzt bleiben')}
        ${chk('trAuto', tr.autoWindows, '<b>Transferfenster automatisch zwischen den Splits</b> (nach dem letzten Spiel bis kurz vor den nächsten Split) — zusätzlich zu deinen eigenen Fenstern')}
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
    + (tr.faMode === 'waiver' ? card('Offene Waiver-Ansprüche', Object.keys(A.claims || {}).length
        ? '<table><tbody>' + Object.entries(A.claims).map(([id, cl]) => cl.map((c, i) => `<tr><td><b>${esc(mname(id))}</b></td><td class="dim">#${i + 1}</td><td class="fill">${esc(pname(c.in))} <span class="dim">für</span> ${esc(pname(c.out))}</td></tr>`).join('')).join('') + '</tbody></table>'
        : '<div class="empty">keine</div>', 'nur du siehst die') : '')
    + card('Liga', `<div class="card-b row" style="flex-wrap:wrap"><input id="lgName" value="${esc(L.name || '')}" style="flex:1;min-width:200px" maxlength="40">${btn('Name speichern', 'name')}</div>`)
    + card('Punkte pro Spiel', `<div class="card-b"><div class="row" style="flex-wrap:wrap;gap:14px">
        <label>Kill ${num('sK', s.kill)}</label><label>Tod ${num('sD', s.death)}</label><label>Assist ${num('sA', s.assist)}</label><label>CS ${num('sC', s.cs10, '0.005')}</label><label>Sieg ${num('sW', s.win)}</label></div>
        <div class="row" style="flex-wrap:wrap;gap:12px;margin-top:12px">${chk('bOn', (s.bonus || {}).enabled, '<b>Bonus</b> für ein großes Spiel:')}
          <label style="margin:0">ab ${num('bTh', (s.bonus || {}).threshold || 10, 1)} Kills <i>oder</i> Assists</label><label style="margin:0">+ ${num('bPts', (s.bonus || {}).points ?? 2, 0.5)} Punkte</label></div>
        <div style="margin-top:12px">${btn('Punkte speichern', 'scoring', {}, 'gold')} <span class="muted" style="font-size:12px">wirkt rückwirkend auf alle Spiele</span></div></div>`)
    + card('Kader', `<div class="card-b" style="display:flex;flex-direction:column;gap:10px">
        <div class="row" style="flex-wrap:wrap;gap:14px"><label style="margin:0">Modell <select id="rPer">
          <option value="0" ${!r.perRole ? 'selected' : ''}>klassisch: 1 je Rolle + Bank</option>
          ${[1, 2, 3].map(n => `<option value="${n}" ${r.perRole === n ? 'selected' : ''}>${n} je Rolle (${n * r.slots.length} Spieler)</option>`).join('')}</select></label>
          <label style="margin:0">Bank (nur klassisch) ${num('rB', r.bench || 0, 1)}</label><label style="margin:0">max. pro LEC-Team ${num('rM', r.maxPerTeam, 1)}</label></div>
        <div class="row" style="flex-wrap:wrap;gap:14px"><label style="margin:0">max. Manager ${num('rMax', r.maxManagers || '', 1)}</label>
          <span class="muted" style="font-size:12px">leer = automatisch · Empfehlung für diesen Kader: <b style="color:var(--text)">${A.suggestedCapacity ?? '?'}</b> (sonst bleibt kaum ein freier Spieler)${r.maxManagers && A.suggestedCapacity && r.maxManagers > A.suggestedCapacity ? ' <span class="pill live">über der Empfehlung</span>' : ''}</span></div>
        <div>${btn('Kader speichern', 'roster', {}, 'gold')}</div></div>`)
    + card('Aufstellung', `<div class="card-b row" style="flex-wrap:wrap;gap:14px">${chk('luOn', S.lineupConfig(L).enabled, '<b>Wöchentliche Aufstellung</b> — nur die 5 Starter punkten, Bank = Ersatz (Auto-Wechsel)')}
        <label style="margin:0">Kapitän ×${num('luCap', S.lineupConfig(L).captain, 0.1)}</label>${btn('Speichern', 'lineup', {}, 'gold')}</div>`)
    + card('Saison', `<div class="card-b row" style="flex-wrap:wrap;gap:12px"><input id="seasonY" value="${esc(L.season || 'auto')}" style="width:120px">${btn('Saison setzen', 'season')}
        <span class="muted" style="font-size:12px">„auto" = aktuelles LEC-Jahr mit allen Splits · sonst z. B. 2027 · Daten: ${esc((ctx.D.season || {}).season || '?')} (${((ctx.D.season || {}).tournaments || []).map(t => esc(t.slug.replace(/^lec_/, ''))).join(', ')})</span></div>`)
    + card('Haupttabelle', `<div class="card-b row">${opBtn('Gesamtpunkte', { op: 'setStandingsMode', mode: 'points' }, '', (L.standingsMode || 'points') === 'points' ? 'gold' : '')}${opBtn('Head-to-Head', { op: 'setStandingsMode', mode: 'h2h' }, '', L.standingsMode === 'h2h' ? 'gold' : '')}</div>`);
}

const PK_DEFAULT = { champion: 10, finalist: 5, firstRegular: 5, lastRegular: 5, mostKills: 5, mostPoints: 5, bestKda: 5, mostChamps: 3, maxKillsGame: 3, mostPicked: 5, longestGame: 5, bloodiest: 5 };
const PK_ON = ['champion', 'finalist', 'firstRegular', 'lastRegular', 'mostKills', 'mostPicked', 'longestGame'];
function viewPickemAdmin() {
  const L = A.league, D = ctx.D;
  const splits = (D.season.tournaments || []).map(t => t);
  const types = Object.entries(S.PICKEM_TYPES);
  const ansLabel = (q, v) => { const k = S.PICKEM_TYPES[q.type].kind; if (v === undefined || v === null || v === '') return '—';
    if (k === 'player') return esc(pname(v)); if (k === 'champion') return esc((D.champs.names || {})[v] || v); return esc(v); };
  if (!splits.length) return card('Pick\'em', '<div class="empty">Keine Saisondaten — erst ein Stats-Update laufen lassen.</div>');
  return splits.map(t => {
    const split = t.slug, pe = (L.pickems || {})[split];
    const lock = S.pickemLock(L, D.schedule, split);
    const done = S.splitDone(D.schedule, split);
    const truth = S.pickemTruth(L, D.stats, D.schedule, split, D.P, D.standings.tournaments[split]);
    const status = pe ? (pe.revealed ? (done ? '<span class="pill teal">ausgewertet</span>' : '<span class="pill gold">aufgedeckt · Split läuft</span>') : '<span class="pill gold">offen</span>') : '<span class="pill">nicht angelegt</span>';
    const editable = !pe || !pe.revealed;
    const qOf = type => pe && pe.questions.find(q => q.type === type && !S.PICKEM_TYPES[type].manual);
    let body = `<div class="card-b muted" style="font-size:12px">Sperre: <b style="color:var(--text)">${lock ? new Date(lock).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'unbekannt (Spielplan fehlt noch)'}</b> — bis dahin sieht niemand die Tipps der anderen; dann deckt das System automatisch auf.</div>`;
    if (editable) {
      body += '<table class="tight"><tbody>' + types.filter(([, def]) => !def.manual).map(([type, def]) => {
        const q = qOf(type), on = q ? true : (!pe && PK_ON.includes(type));
        return `<tr><td style="width:30px"><input type="checkbox" data-pkq="${esc(split)}" value="${type}" ${on ? 'checked' : ''} style="width:auto"></td><td class="fill" style="white-space:normal">${esc(def.label)}</td>
          <td class="num"><input type="number" min="0" data-pkp="${esc(split)}" data-t="${type}" value="${q ? q.points : PK_DEFAULT[type] || 5}" style="width:70px"> Pkt</td></tr>`;
      }).join('') + '</tbody></table>';
      const manual = pe ? pe.questions.filter(q => S.PICKEM_TYPES[q.type].manual) : [];
      body += '<div class="card-b"><div class="muted" style="font-size:12px;margin-bottom:6px">Eigene Fragen (Antwort trägst du nach dem Split ein), z. B. „Meistgebannter Champion":</div>'
        + [0, 1, 2].map(i => { const q = manual[i] || {}; return `<div class="row" data-pkm="${esc(split)}" style="gap:8px;margin-bottom:6px;flex-wrap:wrap">
          <input type="text" placeholder="Frage ${i + 1}" value="${esc(q.label || '')}" style="flex:1;min-width:180px">
          <select>${['manualChamp', 'manualTeam', 'manualPlayer'].map(ty => `<option value="${ty}" ${q.type === ty ? 'selected' : ''}>${{ manualChamp: 'Champion', manualTeam: 'Team', manualPlayer: 'Spieler' }[ty]}</option>`).join('')}</select>
          <input type="number" min="0" value="${q.points ?? 5}" style="width:70px"> Pkt</div>`; }).join('')
        + `<div class="row" style="margin-top:8px">${btn(pe ? 'Fragen speichern' : 'Pick\'em öffnen', 'pkOpen', { split }, 'gold')}${pe ? btn('Jetzt aufdecken', 'pkReveal', { split }) + btn('Löschen', 'pkDelete', { split }) : ''}</div></div>`;
    } else {
      body += '<table class="tight"><tbody>' + pe.questions.map(q => {
        const def = S.PICKEM_TYPES[q.type];
        const auto = def.manual ? null : truth[q.type];
        const autoTxt = auto instanceof Set ? [...auto].slice(0, 3).map(v => ansLabel(q, v)).join(', ') : auto !== undefined ? esc(auto) : '—';
        let input = '';
        if (def.manual) {
          const opts = def.kind === 'team' ? D.teams.teams.map(x => [x.code, x.name]) : def.kind === 'player' ? D.players.players.map(x => [x.id, `${x.name} (${x.team})`]) : Object.entries(D.champs.names || {}).sort((a, b) => a[1].localeCompare(b[1]));
          input = `<select data-pka="${esc(split)}" data-q="${esc(q.id)}"><option value="">—</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(q.answer) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${btn('Antwort', 'pkAnswer', { split, q: q.id })}`;
        }
        return `<tr><td class="fill" style="white-space:normal"><b>${esc(q.label || def.label)}</b> <span class="pill">${q.points}</span></td>
          <td style="white-space:normal">${def.manual ? input : (done ? 'Ergebnis: ' : 'Stand jetzt: ') + autoTxt}</td></tr>`;
      }).join('') + '</tbody></table>';
      const n = Object.keys(pe.picks || {}).length;
      body += `<div class="card-b muted" style="font-size:12px">${n} Manager haben getippt.</div>`;
    }
    return card(`${esc(split.replace(/^lec_/, '').replace(/_/g, ' '))}`, body, status);
  }).join('');
}

function viewHistory() {
  if (!history) return card('Verlauf', '<div class="empty">lade …</div>');
  return card('Verlauf von league.json', history.map((c, i) => `<div style="padding:10px 16px;border-bottom:1px solid var(--line)">
      <div class="row" style="justify-content:space-between;gap:10px"><span class="dim" style="font-size:12px">${new Date(c.date).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} · ${esc(c.short)}</span>
        ${i === 0 ? '<span class="pill teal">aktuell</span>' : opBtn('Wiederherstellen', { op: 'restore', sha: c.sha, force: true }, `Liga auf den Stand „${c.message}" (${c.short}) zurücksetzen? Das ist selbst wieder rückgängig machbar.`)}</div>
      <div style="margin-top:4px;overflow-wrap:anywhere">${esc(c.message)}</div></div>`).join(''),
    'jede Änderung ist ein Eintrag — alles ist rückgängig machbar');
}

function viewBackups() {
  const rows = (backups || []).map(b => `<div style="padding:12px 16px;border-bottom:1px solid var(--line)">
      <div><b>${esc(new Date(b.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }))}</b> <span class="muted">· ${esc(b.label || '')}</span></div>
      <div class="dim" style="font-size:12px;margin:3px 0 8px">${b.managers ?? '?'} Manager · ${b.picks ?? '?'} Picks · ${b.chat ?? 0} Chat · ${Math.max(1, Math.round((b.size || 0) / 1024))} KB</div>
      <div class="row" style="gap:6px;flex-wrap:wrap">${btn('Herunterladen', 'bkGet', { id: b.id })}${btn('Wiederherstellen', 'bkRestore', { id: b.id, at: b.at })}${btn('✕', 'bkDel', { id: b.id })}</div></div>`).join('');
  return card('Backups', `<div class="card-b muted" style="font-size:13px;line-height:1.7">
      <b style="color:var(--text)">Automatisch</b> jeden Morgen ab 5 Uhr, wenn sich seit dem letzten etwas geändert hat — also nach jedem Spieltag eins.
      Die neuesten 60 bleiben. Drin: die ganze Liga plus Chat, noch geheime Pick'em-Tipps, Waiver-Ansprüche, Watchlists und die Logins
      (nur verschlüsselt, und nie in heruntergeladenen Dateien — nach dem Einspielen einer Datei siehst du, wer ein neues Passwort braucht).
      Push-Anmeldungen schaltet jeder einfach wieder an.<br>
      Zusätzlich speichert GitHub jede einzelne Änderung der Liga — siehe Tab <b style="color:var(--text)">Verlauf</b>.</div>
    <div class="card-b row" style="flex-wrap:wrap;border-top:1px solid var(--line)">${btn('Jetzt Backup machen', 'bkNow', {}, 'gold')}
      <label class="btn sm" style="margin:0;cursor:pointer">Backup-Datei hochladen …<input type="file" id="bkFile" accept="application/json,.json" style="display:none"></label>
      <span class="muted" style="font-size:12px">Tipp: ab und zu eins herunterladen und auf dem PC behalten.</span></div>`)
    + card('Gespeicherte Backups', backups === null ? '<div class="empty">lade …</div>' : rows ? rows : '<div class="empty">Noch keins — das erste kommt morgen früh, oder jetzt per Knopf.</div>',
      backups ? `${backups.length} Stück` : '');
}

function viewTest() {
  const L = A.league, tm = L.testMode, st = window.LECScoring.draftStatus(L);
  if (!tm || !tm.on) {
    return card('Testmodus', `<div class="card-b" style="line-height:1.7">
      <p style="margin-top:0">Spiel alles einmal selbst durch — mit Bots als Gegnern und den echten Punkten der Saison.</p>
      <ol class="muted" style="padding-left:18px;margin:0 0 12px">
        <li>Beim Start wird ein <b style="color:var(--text)">Backup</b> gemacht.</li>
        <li>Die Bots treten bei. Sie draften sofort, wenn sie dran sind, tippen beim Pick'em, nehmen faire Trades an und antworten manchmal im Chat.</li>
        <li>Du trittst mit einem eigenen Spieler-Account über den Einladungslink bei und spielst ganz normal.</li>
        <li><b style="color:var(--text)">Testmodus beenden</b> spielt das Backup zurück — danach ist alles wie vorher, auch dein Test-Account ist wieder weg.</li></ol>
      ${st !== 'lobby' ? '<div class="msg err">Geht nur vor dem Draft (Status Anmeldung). Erst unter Draft zurücksetzen.</div>' : `<div class="row" style="flex-wrap:wrap;gap:10px">
        <label style="margin:0;display:flex;gap:8px;align-items:center">Bots <select id="tmBots">${[1, 2, 3, 4, 5].map(n => `<option ${n === 3 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        ${btn('Testmodus starten', 'tmStart', {}, 'gold')}</div>`}</div>`);
  }
  const inv = A.invite;
  const link = inv ? `${location.origin}${location.pathname}#/join/${inv.code}` : '';
  const bots = (tm.bots || []).map(id => (L.managers.find(m => m.id === id) || {}).name).filter(Boolean);
  const humans = L.managers.filter(m => !(tm.bots || []).includes(m.id));
  const step = (done, title, body) => `<div style="padding:14px 16px;border-bottom:1px solid var(--line)"><div style="display:flex;gap:10px;align-items:flex-start">
      <span style="font-size:18px;width:22px">${done ? '✅' : '⬜'}</span><div style="flex:1;min-width:0"><b>${title}</b><div class="muted" style="font-size:13px;margin-top:4px;line-height:1.6">${body}</div></div></div></div>`;
  return card('Testmodus läuft', `<div class="card-b muted" style="font-size:13px">Seit ${esc(new Date(tm.startedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }))} · Bots: <b style="color:var(--text)">${esc(bots.join(', '))}</b> · Backup vorher: ${esc(tm.backupId)}</div>`
      + step(humans.length > 0, '1. Als Spieler beitreten', humans.length ? `Dabei: ${esc(humans.map(m => m.name).join(', '))}` : `Öffne den Link in einem <b>privaten Fenster</b> oder am Handy und melde dich mit Name + Passwort an:
          <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:8px"><input id="invLink" value="${esc(link)}" readonly style="flex:1;min-width:0">${btn('Kopieren', 'copy', {}, 'gold')}</div>`)
      + step(st !== 'lobby', '2. Draft starten', st === 'lobby' ? `<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:6px">${opBtn('Reihenfolge mischen', { op: 'shuffleOrder' })}${opBtn('Draft jetzt starten', { op: 'setStatus', status: 'live' }, 'Draft starten?', 'gold')}</div>` : st === 'live' ? 'läuft — die Bots picken sofort, wenn sie dran sind' : 'fertig')
      + step(Object.keys(L.pickems || {}).length > 0, "3. Pick'em testen", `Öffnet einen Pick'em mit Sperre in ein paar Minuten. Die Bots tippen sofort; nach der Sperre deckt das System auf und wertet direkt aus (die Saison ist ja gespielt).
          <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:8px"><label style="margin:0;display:flex;gap:6px;align-items:center">Sperre in <select id="tmMin">${[2, 5, 10, 30].map(n => `<option ${n === 5 ? 'selected' : ''}>${n}</option>`).join('')}</select> Min</label>${btn("Test-Pick'em öffnen", 'tmPickem', {}, 'gold')}</div>`)
      + step(Object.values(L.events || {}).some(e => e.replay), '3b. Special Event testen', `Spielt ein fertiges Event (z. B. MSI 2026) im Zeitraffer noch einmal ab: erst ${'10'} Minuten Team bauen &amp; tippen, dann laufen die echten Spiele im Schnelldurchlauf, mit Punkten, Phasenwechsel, Auflösung und Ruhmeshalle.
          <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:8px"><select id="tmEv">${(((ctx.D.eventsIndex || {}).events) || []).filter(e => e.done).map(e => `<option value="${esc(e.slug)}">${esc(e.name)} ${esc(String(e.start).slice(0, 4))}</option>`).join('')}</select>
          <label style="margin:0;display:flex;gap:6px;align-items:center">Dauer <select id="tmEvMin">${[20, 30, 45].map(n => `<option ${n === 30 ? 'selected' : ''}>${n}</option>`).join('')}</select> Min</label>${btn('Event-Wiederholung starten', 'tmReplay', {}, 'gold')}</div>`)
      + step(false, '4. Rumprobieren', `Aufstellung setzen, Trades mit den Bots (faire Angebote nehmen sie an), Chat, Rückblick, LEC-Tab.
          <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:8px">${opBtn('Waiver jetzt laufen lassen', { op: 'runWaivers' })}${btn('Ruhmeshalle füllen', 'tmHall')}</div>`)
      + step(false, '5. Fertig?', `Alles zurück auf den Stand vor dem Test.<div style="margin-top:8px">${btn('Testmodus beenden', 'tmEnd', {}, 'gold')}</div>`));
}

// ── special events ────────────────────────────────────────────────────────
const EVA = { data: {} };
const EV_PK_DEFAULT = { champion: 10, finalist: 5, swiss30: 5, swiss03: 5, winnerRegion: 5, mostKills: 5, mostPoints: 5, bestKda: 5, mostChamps: 3, maxKillsGame: 3, mostPicked: 5, longestGame: 5, bloodiest: 5 };
const EV_PK_ON = ['champion', 'finalist', 'swiss30', 'swiss03', 'winnerRegion', 'mostKills', 'mostPicked', 'longestGame'];
function evaData(slug) {
  if (EVA.data[slug] === undefined) { EVA.data[slug] = null; ctx.U.getJson('data/events/' + slug + '.json', true).then(d => { EVA.data[slug] = d || {}; draw(); }); }
  return EVA.data[slug];
}
function viewEventsAdmin() {
  const S = window.LECScoring, idx = ((ctx.D.eventsIndex || {}).events) || [], evs = A.league.events || {};
  if (!idx.length) return card('Events', '<div class="empty">Noch keine Event-Daten — die kommen mit dem nächsten Stats-Update (Stats → Jetzt aktualisieren).</div>');
  return idx.map(info => {
    const ev = evs[info.slug];
    const dates = `${new Date(info.start).toLocaleDateString('de-DE')} – ${new Date(info.end).toLocaleDateString('de-DE')}`;
    const head = `<div class="card-b row" style="gap:14px;flex-wrap:wrap">${info.logo ? `<img src="${esc(info.logo)}" alt="" style="height:40px;max-width:110px;object-fit:contain">` : ''}
      <div style="flex:1;min-width:160px"><b>${esc(info.name)} ${esc(String(info.start).slice(0, 4))}</b><div class="dim" style="font-size:12px">${dates} · ${info.ready ? info.teams + ' Teams' + (info.done ? ' · vorbei' : '') : 'Teams stehen noch nicht fest'}</div></div>
      ${ev ? '<span class="pill teal">angelegt</span>' : ''}</div>`;
    if (!ev && info.done) return card(esc(info.name), head + '<div class="card-b muted" style="font-size:13px;border-top:1px solid var(--line)">Schon vorbei — zum Ausprobieren unter Testmodus als Wiederholung abspielen.</div>');
    if (!ev) {
      return card(esc(info.name), head + `<div class="card-b" style="border-top:1px solid var(--line)">
        <label>Name</label><input id="evn_${info.slug}" value="${esc(info.name + ' ' + String(info.start).slice(0, 4))}" style="width:100%">
        <label>YouTube-Link für Intro &amp; Musik (optional, z. B. die offizielle Hymne)</label><input id="evv_${info.slug}" placeholder="https://www.youtube.com/watch?v=…" style="width:100%">
        <div style="margin-top:12px">${btn('Event anlegen', 'evCreate', { slug: info.slug }, 'gold')}</div></div>`);
    }
    const c = S.eventConfig(ev), d = evaData(info.slug);
    const prices = !d ? '<div class="empty">lade Teams …</div>' : !(d.teams || []).length ? '<div class="empty">Teams stehen noch nicht fest — Preise danach.</div>'
      : `<div class="card-b" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">${d.teams.map(t => `<label class="row" style="gap:8px;margin:0;color:var(--text)">${t.logo ? `<img src="${esc(t.logo)}" alt="" width="22" height="22">` : ''}<span style="flex:1"><b>${esc(t.code)}</b> <span class="dim" style="font-size:11px">${esc(t.league)}</span></span>
          <input type="number" min="1" max="100" data-evprice="${esc(t.code)}" value="${S.eventTeamPrice(ev, d, t.code)}" style="width:62px"></label>`).join('')}</div>
        <p class="muted" style="font-size:12px;margin:0 16px 12px">Credits pro Spieler. Vorschlag: LCK/LPL 25, LEC 20, Rest 15 — 5 Spieler, Budget ${c.budget}.</p>`;
    const pe = ev.pickem || {}, on = new Set((pe.questions || []).map(q => q.type)), pts = Object.fromEntries((pe.questions || []).map(q => [q.type, q.points]));
    const firstLock = d && S.eventStages(d).find(x => x.lock !== null);
    const lockVal = pe.lockAt ? pe.lockAt.slice(0, 16) : '';
    const types = Object.entries(S.EVENT_TYPES).filter(([, t]) => !t.manual);
    const pk = pe.revealed
      ? `<div class="card-b muted" style="font-size:13px">Aufgedeckt — ${Object.keys(pe.picks || {}).length} Manager haben getippt.</div>` + (pe.questions || []).filter(q => S.EVENT_TYPES[q.type].manual).map(q => `<div class="card-b row" style="gap:8px;flex-wrap:wrap"><b style="flex:1">${esc(q.label || q.type)}</b><input id="eva_${info.slug}_${q.id}" value="${esc(q.answer || '')}" placeholder="Antwort (Kürzel / Name)">${btn('Antwort', 'evAnswer', { slug: info.slug, qid: q.id })}</div>`).join('')
      : `<div class="card-b">${types.map(([k, t]) => `<label class="row" style="gap:8px;margin:0 0 6px;color:var(--text)"><input type="checkbox" data-evpk="${info.slug}" value="${k}" ${(pe.questions ? on.has(k) : EV_PK_ON.includes(k)) ? 'checked' : ''} style="width:auto"><span style="flex:1">${esc(t.label)}</span><input type="number" min="0" data-evpkp="${info.slug}" data-t="${k}" value="${pts[k] ?? EV_PK_DEFAULT[k] ?? 5}" style="width:60px"> Pkt</label>`).join('')}
        <label>Eigene Frage (Antwort trägst du nach dem Event ein)</label><div class="row" style="gap:8px;flex-wrap:wrap"><input id="evcq_${info.slug}" placeholder="z. B. MVP der Finals" style="flex:1;min-width:160px" value="${esc(((pe.questions || []).find(q => q.type === 'manualPlayer') || {}).label || '')}"><input id="evcp_${info.slug}" type="number" value="5" style="width:60px"> Pkt</div>
        <label>Tipp-Schluss (leer = erstes Spiel${firstLock ? ': ' + new Date(firstLock.lock).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : ''})</label><input type="datetime-local" id="evl_${info.slug}" value="${esc(lockVal)}">
        <div style="margin-top:12px">${btn(pe.questions ? "Pick'em speichern" : "Pick'em öffnen", 'evPickem', { slug: info.slug }, 'gold')}</div></div>`;
    return card(esc(ev.name), head
      + `<div class="card-b" style="border-top:1px solid var(--line)"><div class="grid g-2" style="gap:10px">
          <label style="margin:0">Name<input id="evn_${info.slug}" value="${esc(ev.name)}" style="width:100%"></label>
          <label style="margin:0">Budget<input id="evb_${info.slug}" type="number" value="${c.budget}" style="width:100%"></label>
          <label style="margin:0">Max. Spieler pro Team<input id="evm_${info.slug}" type="number" min="1" max="5" value="${c.maxPerTeam}" style="width:100%"></label>
          <label style="margin:0">Kapitän ×<input id="evc_${info.slug}" type="number" step="0.1" value="${c.captain}" style="width:100%"></label>
          <label style="margin:0">YouTube-Link (Intro &amp; Musik)<input id="evv_${info.slug}" value="${ev.video ? 'https://youtu.be/' + esc(ev.video) : ''}" placeholder="leer = kein Video" style="width:100%"></label>
          <label style="margin:0">Video ab Sekunde<input id="evs_${info.slug}" type="number" min="0" value="${ev.videoStart || 0}" style="width:100%"></label></div>
        <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap">${btn('Speichern', 'evSave', { slug: info.slug }, 'gold')}<a class="btn sm" href="#/event/${esc(info.slug)}">Event-Seite</a>${btn('Event löschen', 'evDelete', { slug: info.slug })}</div></div>`
      + `<div class="card-h" style="border-top:1px solid var(--line)"><h2>Team-Preise</h2></div>${prices}`
      + `<div class="card-h" style="border-top:1px solid var(--line)"><h2>Pick'em</h2></div>${pk}`);
  }).join('');
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
    <b style="color:var(--text)">Daten kaputt oder weg</b> → Tab Backups: Stand von gestern (bzw. vom letzten Spieltag) wiederherstellen — der jetzige Stand wird vorher gesichert. Nur die Liga betroffen? Tab Verlauf: auf jede einzelne frühere Änderung zurück.<br>
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

const TABS = [['overview', 'Übersicht'], ['draft', 'Draft'], ['members', 'Mitglieder'], ['points', 'Punkte'], ['stats', 'Stats'], ['pickem', "Pick'em"], ['events', 'Events'], ['settings', 'Einstellungen'], ['history', 'Verlauf'], ['backup', 'Backups'], ['test', 'Testmodus'], ['raw', 'Rohdaten'], ['emergency', 'Notfall']];
function draw() {
  if (!root) return;
  if (!tokenGet()) { root.innerHTML = viewLogin(flash && !flash.ok ? flash.text : ''); bind(); return; }
  if (!A) { root.innerHTML = '<div class="empty">lade Admin …</div>'; return; }
  const issues = A.validation.errors.length;
  const body = { overview: viewOverview, draft: viewDraft, members: viewMembers, points: viewPoints, stats: viewStats, backup: viewBackups, test: viewTest, pickem: viewPickemAdmin, events: viewEventsAdmin, settings: viewSettings, history: viewHistory, raw: viewRaw, emergency: viewEmergency }[tab]();
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
  const bkFile = document.getElementById('bkFile');
  if (bkFile) bkFile.onchange = async () => {
    const f = bkFile.files && bkFile.files[0];
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch (e) { flash = { ok: false, text: 'Datei ist kein gültiges JSON.' }; return draw(); }
    const when = data && data.at ? new Date(data.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '?';
    if (!window.confirm(`Backup-Datei vom ${when} einspielen? Der jetzige Stand wird vorher gesichert.`)) return;
    try { const r = await api('/api/admin/backup', { method: 'POST', body: { action: 'restore', data } }); flash = { ok: true, text: r.message }; await load(); } catch (e) { flash = { ok: false, text: e.message }; }
    loadBackups();
  };
  root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; flash = null; if (tab === 'history') loadHistory(); if (tab === 'backup') loadBackups(); draw(); });
  root.querySelectorAll('[data-act]').forEach(el => {
    const ev = el.tagName === 'SELECT' ? 'onchange' : 'onclick';
    el[ev] = () => act(el.dataset.act, el.dataset, el);
  });
}

async function runHealth() { health = null; draw(); try { health = (await api('/api/admin/health')).checks; } catch (e) { health = [{ name: 'Health', ok: false, detail: e.message }]; } draw(); }
let backups = null;
async function loadBackups() { backups = null; draw(); try { backups = (await api('/api/admin/backups')).backups; } catch (e) { flash = { ok: false, text: e.message }; backups = []; } draw(); }
async function loadHistory() { history = null; draw(); try { history = (await api('/api/admin/history')).commits; } catch (e) { flash = { ok: false, text: e.message }; history = []; } draw(); }
const J = s => { try { return JSON.parse(s); } catch (e) { return s; } };

async function act(a, d, el) {
  const L = A.league;
  switch (a) {
    case 'op': return op(J(d.op), d.confirm || null);
    case 'reload': flash = null; await load(); if (tab === 'overview') runHealth(); if (tab === 'history') loadHistory(); return;
    case 'alogout': tokenDel(); A = null; draw(); return;
    case 'health': return runHealth();
    case 'hall':
      if (d.mode === 'delete' && !window.confirm('Eintrag aus der Ruhmeshalle entfernen?')) return;
      try { const r = await api('/api/admin/hall', { method: 'POST', body: { split: d.split || val('hallSplit'), action: d.mode === 'delete' ? 'delete' : 'build' } }); flash = { ok: true, text: r.message }; await load(); } catch (e) { flash = { ok: false, text: e.message }; draw(); }
      return;
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
    case 'scoring': return op({ op: 'setScoring', scoring: { kill: +val('sK'), death: +val('sD'), assist: +val('sA'), cs10: +val('sC'), win: +val('sW'),
      bonus: { enabled: document.getElementById('bOn').checked, threshold: parseInt(val('bTh'), 10), points: +val('bPts') } } }, 'Punkte ändern? Gilt rückwirkend für alle Spiele.');
    case 'schedule': {
      if (!val('dAt')) { flash = { ok: false, text: 'Termin wählen' }; return draw(); }
      return op({ op: 'setDraftSchedule', at: new Date(val('dAt')).toISOString(), reminderMinutes: parseInt(val('dRem'), 10) || 0, autoStart: document.getElementById('dAuto').checked });
    }
    case 'scheduleClear': return op({ op: 'setDraftSchedule', at: null, reminderMinutes: 60, autoStart: false }, 'Draft-Termin entfernen?');
    case 'roster': return op({ op: 'setRoster', roster: { slots: L.roster.slots, bench: +val('rB'), maxPerTeam: +val('rM'), perRole: +val('rPer') || 0, maxManagers: +val('rMax') || 0 }, force: true }, (L.draft.picks || []).length ? 'Kaderregeln nach Draftbeginn ändern?' : null);
    case 'lineup': return op({ op: 'setLineupRules', enabled: document.getElementById('luOn').checked, captain: +String(val('luCap')).replace(',', '.') });
    case 'season': return op({ op: 'setSeason', season: val('seasonY') });
    case 'faab': return op({ op: 'setFaab', budget: parseInt(val('fBud'), 10), resetEachSplit: document.getElementById('fReset').checked });
    case 'pkOpen': {
      const split = d.split, qs = [];
      root.querySelectorAll(`[data-pkq="${CSS.escape(split)}"]`).forEach(c => { if (c.checked) qs.push({ type: c.value, points: +root.querySelector(`[data-pkp="${CSS.escape(split)}"][data-t="${c.value}"]`).value || 0 }); });
      root.querySelectorAll(`[data-pkm="${CSS.escape(split)}"]`).forEach(row => {
        const label = row.querySelector('input[type=text]').value.trim();
        if (label) qs.push({ type: row.querySelector('select').value, points: +row.querySelector('input[type=number]').value || 0, label });
      });
      return op({ op: 'pickemOpen', split, questions: qs }, `Pick'em für ${split} mit ${qs.length} Fragen speichern?`);
    }
    case 'pkAnswer': return op({ op: 'pickemAnswer', split: d.split, qid: d.q, answer: root.querySelector(`[data-pka="${CSS.escape(d.split)}"][data-q="${CSS.escape(d.q)}"]`).value });
    case 'pkReveal': return op({ op: 'pickemReveal', split: d.split }, 'Alle Tipps jetzt aufdecken? Danach sind keine Änderungen mehr möglich.');
    case 'pkDelete': return op({ op: 'pickemDelete', split: d.split }, `Pick'em ${d.split} löschen?`);
    case 'trades': case 'winAdd': case 'winDel': {
      const cur = window.LECScoring.transferRules(L);
      const g = id => document.getElementById(id);
      const rules = a === 'trades' ? {
        enabled: g('trOn').checked, freeAgents: g('trFa').checked, perWeek: Math.max(0, parseInt(val('trPer'), 10) || 0),
        faMode: (root.querySelector('input[name="faMode"]:checked') || {}).value || 'instant',
        waiver: { days: [...root.querySelectorAll('[data-wday]')].filter(x => x.checked).map(x => +x.dataset.wday), time: val('wvTime') || '03:00', order: val('wvOrder') || 'reverse' },
        rosterRules: g('trRos').checked, teamLimit: g('trTeam').checked, autoWindows: g('trAuto').checked, equalCount: g('trEq').checked, adminApproval: g('trAdm').checked,
        mode: (root.querySelector('input[name="trMode"]:checked') || {}).value || 'windows', windows: cur.windows,
      } : Object.assign({}, cur);
      if (a === 'winAdd') {
        if (!val('wFrom') || !val('wTo')) { flash = { ok: false, text: 'Von und Bis angeben' }; return draw(); }
        rules.windows = (cur.windows || []).concat({ from: new Date(val('wFrom') + 'T00:00:00').toISOString(), to: new Date(val('wTo') + 'T23:59:59').toISOString(), label: val('wLabel') });
      }
      if (a === 'winDel') rules.windows = (cur.windows || []).filter((_, k) => k !== +d.i);
      return op({ op: 'setTradeRules', rules }, a === 'winDel' ? 'Fenster löschen?' : null);
    }
    case 'tmReplay':
      busy = true; draw();
      try { const r = await api('/api/admin/test', { method: 'POST', body: { action: 'replay', slug: val('tmEv'), minutes: +val('tmEvMin') || 30 } }); flash = { ok: true, text: r.message }; } catch (e) { flash = { ok: false, text: e.message }; }
      busy = false; return load();
    case 'tmStart': case 'tmEnd': case 'tmPickem': case 'tmHall': {
      if (a === 'tmEnd' && !window.confirm('Testmodus beenden? Liga, Chat und Tipps gehen auf den Stand vor dem Test zurück.')) return;
      const body = { action: { tmStart: 'start', tmEnd: 'end', tmPickem: 'pickem', tmHall: 'hall' }[a], bots: +val('tmBots') || 3, minutes: +val('tmMin') || 5 };
      busy = true; draw();
      try { const r = await api('/api/admin/test', { method: 'POST', body }); flash = { ok: true, text: r.message }; } catch (e) { flash = { ok: false, text: e.message }; }
      busy = false; return load();
    }
    case 'evCreate': case 'evSave': case 'evPickem': case 'evAnswer': case 'evDelete': {
      const slug = d.slug, v = id => val(id + '_' + slug);
      let body;
      if (a === 'evCreate') body = { action: 'create', slug, name: v('evn'), video: v('evv') };
      if (a === 'evSave') {
        const prices = {};
        root.querySelectorAll('[data-evprice]').forEach(el => { prices[el.dataset.evprice] = +el.value; });
        body = { action: 'update', slug, name: v('evn'), budget: +v('evb'), maxPerTeam: +v('evm'), captain: +v('evc'), video: v('evv'), videoStart: +v('evs') || 0 };
        if (Object.keys(prices).length) body.prices = prices;
      }
      if (a === 'evPickem') {
        const qs = [];
        root.querySelectorAll(`[data-evpk="${slug}"]`).forEach(cb => { if (cb.checked) qs.push({ type: cb.value, points: +root.querySelector(`[data-evpkp="${slug}"][data-t="${cb.value}"]`).value || 0 }); });
        if (v('evcq').trim()) qs.push({ type: 'manualPlayer', label: v('evcq').trim(), points: +v('evcp') || 0 });
        const l = v('evl');
        body = { action: 'pickem', slug, questions: qs, lockAt: l ? new Date(l).toISOString() : null };
      }
      if (a === 'evAnswer') body = { action: 'answer', slug, qid: d.qid, answer: val('eva_' + slug + '_' + d.qid) };
      if (a === 'evDelete') { if (!window.confirm('Event löschen? Teams und Tipps dazu sind dann weg.')) return; body = { action: 'delete', slug }; }
      try { const r = await api('/api/admin/event', { method: 'POST', body }); flash = { ok: true, text: r.message }; } catch (e) { flash = { ok: false, text: e.message }; }
      return load();
    }
    case 'bkNow':
      try { const r = await api('/api/admin/backup', { method: 'POST', body: { action: 'create' } }); flash = { ok: true, text: r.message }; } catch (e) { flash = { ok: false, text: e.message }; }
      return loadBackups();
    case 'bkDel':
      if (!window.confirm(`Backup ${d.id} löschen?`)) return;
      try { const r = await api('/api/admin/backup', { method: 'POST', body: { action: 'delete', id: d.id } }); flash = { ok: true, text: r.message }; } catch (e) { flash = { ok: false, text: e.message }; }
      return loadBackups();
    case 'bkGet':
      try {
        const b = await api('/api/admin/backup?id=' + encodeURIComponent(d.id));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(b, null, 1)], { type: 'application/json' }));
        a.download = `lecfantasy-backup-${d.id}.json`; document.body.appendChild(a); a.click(); a.remove();
      } catch (e) { flash = { ok: false, text: e.message }; draw(); }
      return;
    case 'bkRestore': {
      const when = new Date(d.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
      if (!window.confirm(`Liga, Chat, Tipps und Ansprüche auf den Stand vom ${when} zurücksetzen?\n\nDer jetzige Stand wird vorher automatisch als Backup gesichert.`)) return;
      try { const r = await api('/api/admin/backup', { method: 'POST', body: { action: 'restore', id: d.id } }); flash = { ok: true, text: r.message }; await load(); } catch (e) { flash = { ok: false, text: e.message }; }
      return loadBackups();
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
