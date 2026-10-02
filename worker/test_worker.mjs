// ═══════════════════════════════════════════════════════════════════════════
// test_worker.mjs — the Worker end to end, in plain node, no network.
//
// KV (with list + metadata), the GitHub API (contents with real commit
// history, commits, rate limit, repo perms, workflow runs) and the public
// Pages data are simulated in memory. Covers the invite/join/login flow, the
// draft referee, every admin intervention, restore-from-history, the
// validation guard, the pick timer, trades, and that no secret ever leaks.
//
//     node worker/test_worker.mjs
// ═══════════════════════════════════════════════════════════════════════════

// ── stubs ──────────────────────────────────────────────────────────────────
function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k, type) { const e = m.get(k); if (!e) return null; return type === 'json' ? JSON.parse(e.v) : e.v; },
    async put(k, v, o) { m.set(k, { v, meta: (o && o.metadata) || null }); },
    async delete(k) { m.delete(k); },
    async list(o) {
      const keys = [...m.entries()].filter(([k]) => k.startsWith((o && o.prefix) || '')).map(([name, e]) => ({ name, metadata: e.meta }));
      return { keys, list_complete: true };
    },
  };
}

function makeGitHub(seed) {
  // per path: list of versions [{sha, text, message, date}] newest last
  const files = new Map();
  let n = 0;
  const commit = (path, obj, message) => {
    const v = { sha: 'c' + String(++n).padStart(39, '0'), text: JSON.stringify(obj, null, 2) + '\n', message, date: new Date(Date.now() + n * 1000).toISOString() };
    if (!files.has(path)) files.set(path, []);
    files.get(path).push(v);
    return v;
  };
  for (const [p, o] of Object.entries(seed)) commit(p, o, 'seed');
  const stats = { puts: 0, conflicts: 0, dispatched: 0 };
  const latest = p => { const l = files.get(p); return l && l[l.length - 1]; };
  async function handle(url, init = {}) {
    const u = new URL(url);
    const method = init.method || 'GET';
    let m;
    if (u.pathname === '/rate_limit') return J({ resources: { core: { remaining: 4900, limit: 5000, reset: 0 } } });
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/))) return J({ private: m[1].endsWith('-data'), permissions: { push: true } });
    if (u.pathname.endsWith('/actions/workflows/update-stats.yml/runs')) return J({ workflow_runs: [{ status: 'completed', conclusion: 'success', created_at: new Date().toISOString() }] });
    if (u.pathname.endsWith('/actions/workflows/update-stats.yml/dispatches')) { stats.dispatched++; return new Response(null, { status: 204 }); }
    if ((m = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/commits$/))) {
      const l = (files.get(u.searchParams.get('path')) || []).slice().reverse();
      return J(l.map(v => ({ sha: v.sha, commit: { message: v.message, author: { name: 'bot', date: v.date } } })));
    }
    if ((m = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/))) {
      const path = decodeURIComponent(m[1]);
      if (method === 'GET') {
        const ref = u.searchParams.get('ref');
        const l = files.get(path) || [];
        const v = ref && ref.startsWith('c') ? l.find(x => x.sha === ref) : l[l.length - 1];
        if (!v) return new Response('{}', { status: 404 });
        return J({ content: Buffer.from(v.text).toString('base64').replace(/(.{60})/g, '$1\n'), sha: v.sha });
      }
      if (method === 'PUT') {
        stats.puts++;
        const b = JSON.parse(init.body);
        const cur = latest(path);
        if ((cur && b.sha !== cur.sha) || (!cur && b.sha)) { stats.conflicts++; return new Response('{"message":"conflict"}', { status: 409 }); }
        const v = commit(path, JSON.parse(Buffer.from(b.content, 'base64').toString('utf8')), b.message);
        return J({ content: { sha: v.sha } });
      }
    }
    return new Response('not found ' + u.pathname, { status: 404 });
  }
  return { handle, files, stats, current: p => JSON.parse(latest(p).text), messages: p => files.get(p).map(v => v.message) };
}
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

// ── fixtures ───────────────────────────────────────────────────────────────
const TEAMS = ['G2', 'FNC', 'KC', 'MKOI', 'VIT', 'TH'], ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
const PLAYERS = { players: TEAMS.flatMap(t => ROLES.map(r => ({ id: `${t}_${r}`, name: `${t} ${r}`, team: t, role: r }))) };
// G2 players score most, so the auto-pick should go for G2 first
const STATS = { updated: Math.floor(Date.now() / 1000), tournament: 't', games: PLAYERS.players.map((p, i) => ({ game: 'g' + i, match: 'x', player: p.id, ts: '2026-08-01', k: p.team === 'G2' ? 9 : 1, d: 0, a: 0, cs: 0, win: false })) };
const LEAGUE = {
  name: 'Test Liga', tournament: 'auto',
  scoring: { kill: 3, death: -1, assist: 1.5, cs10: 0.02, win: 2 },
  roster: { slots: ROLES, bench: 1, maxPerTeam: 2 },
  managers: [], draft: { order: [], snake: true, picks: [], status: 'lobby', completed: false },
  swaps: [], trades: [], adjustments: [],
};
const SECRET_TOKEN = 'ghp_SECRET_never_leaves', ADMIN_PW = 'admin-pass-123456';
let SCHEDULE = { events: [] }, SEASON = { tournaments: [] };

let worker, env, gh, realFetch = globalThis.fetch;
async function setup() {
  gh = makeGitHub({ 'league.json': JSON.parse(JSON.stringify(LEAGUE)) });
  SCHEDULE = { events: [] }; SEASON = { tournaments: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://api.github.com/')) return gh.handle(u.replace('https://api.github.com', 'https://x'), init);
    if (u.startsWith('https://pages.test/data/players.json')) return J(PLAYERS);
    if (u.startsWith('https://pages.test/data/stats.json')) return J(STATS);
    if (u.startsWith('https://pages.test/data/schedule.json')) return J(SCHEDULE);
    if (u.startsWith('https://pages.test/data/season.json')) return J(SEASON);
    if (u.startsWith('https://pages.test/data/')) return J({ updated: Math.floor(Date.now() / 1000), tournament: 't' });
    return new Response('unexpected fetch ' + u, { status: 599 });
  };
  env = {
    LEAGUE: makeKV(), GITHUB_TOKEN: SECRET_TOKEN, ADMIN_PASSWORD: ADMIN_PW,
    GITHUB_REPO: 'me/site', DATA_REPO: 'me/site-data', GITHUB_BRANCH: 'main',
    PAGES_URL: 'https://pages.test', ALLOWED_ORIGIN: 'https://fne-stack.github.io',
  };
  if (!worker) worker = (await import('./src/index.js')).default;
}
const bodies = [];
async function call(method, path, { body, token } = {}) {
  const headers = { Origin: 'https://fne-stack.github.io' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await worker.fetch(new Request('https://w.dev' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, body: JSON.parse(text) };
}
const league = () => gh.current('league.json');

// helpers to get a league going
async function admin() { return (await call('POST', '/api/admin/login', { body: { username: 'admin', password: ADMIN_PW } })).body.token; }
async function invite(a) { return (await call('POST', '/api/admin/invite', { token: a })).body.invite.code; }
async function join(code, name, pw = 'secret-' + name) {
  const r = await call('POST', '/api/join', { body: { code, name, password: pw } });
  if (r.status !== 200) throw new Error(`join ${name}: ${r.status} ${r.body.error}`);
  return r.body.token;
}
async function liveLeague(names) {
  const a = await admin(), code = await invite(a), tok = {};
  for (const n of names) tok[n] = await join(code, n);
  await call('POST', '/api/admin/op', { token: a, body: { op: 'setStatus', status: 'live' } });
  const ids = Object.fromEntries(league().managers.map(m => [m.name, m.id]));
  return { a, code, tok, ids };
}

// ── tests ──────────────────────────────────────────────────────────────────
const tests = {};

tests.nothing_without_login = async () => {
  for (const [m, p] of [['GET', '/api/state'], ['POST', '/api/pick'], ['GET', '/api/queue'], ['GET', '/api/admin/state'], ['POST', '/api/admin/op']]) {
    const r = await call(m, p, { body: m === 'POST' ? {} : undefined });
    assert(r.status === 401, `${m} ${p} without login -> ${r.status}`);
  }
  const r = await call('POST', '/api/invite', { body: { code: 'nope' } });
  assert(r.status === 404, 'bad invite code must 404');
  return 'state, pick, queue, admin all 401; bad invite 404';
};

tests.invite_join_login = async () => {
  const a = await admin(), code = await invite(a);
  const info = await call('POST', '/api/invite', { body: { code } });
  assert(info.status === 200 && info.body.members === 0 && !info.body.managers, 'invite check shows count, never names');
  const t = await join(code, 'Fabi');
  assert((await call('GET', '/api/state', { token: t })).body.me.name === 'Fabi', 'joined + logged in');
  let r = await call('POST', '/api/join', { body: { code, name: 'fabi', password: 'whatever1' } });
  assert(r.status === 409, 'duplicate name (case-insensitive) refused');
  r = await call('POST', '/api/join', { body: { code, name: 'ADMIN', password: 'whatever1' } });
  assert(r.status === 400 && /reserviert/.test(r.body.error), 'admin is a reserved name');
  r = await call('POST', '/api/join', { body: { code, name: 'Tim', password: '123' } });
  assert(r.status === 400, 'short password refused');
  r = await call('POST', '/api/login', { body: { name: '  FABI ', password: 'secret-Fabi' } });
  assert(r.status === 200 && r.body.token, 'login by name, case/space-insensitive');
  r = await call('POST', '/api/login', { body: { name: 'Fabi', password: 'wrong-pass' } });
  assert(r.status === 401 && /Name oder Passwort/.test(r.body.error), 'wrong password: generic message');
  r = await call('POST', '/api/login', { body: { name: 'Nobody', password: 'x' } });
  assert(r.status === 401 && /Name oder Passwort/.test(r.body.error), 'unknown name: same generic message');
  const old = code, fresh = await invite(a);
  r = await call('POST', '/api/join', { body: { code: old, name: 'Late', password: 'secret12' } });
  assert(r.status === 404 && fresh !== old, 'rotating the invite kills the old link');
  return 'invite check leaks no names, join, dup/short refused, login by name, generic errors, rotation';
};

tests.capacity_and_closed_lobby = async () => {
  const a = await admin(), code = await invite(a);
  // 30 players, roster 6 -> 80% rule allows 4
  for (const n of ['Ann', 'Ben', 'Cem', 'Dan']) await join(code, n);
  let r = await call('POST', '/api/join', { body: { code, name: 'Eva', password: 'secret12' } });
  assert(r.status === 409 && /voll/.test(r.body.error), 'full league refused: ' + r.body.error);
  await call('POST', '/api/admin/op', { token: a, body: { op: 'removeManager', manager: league().managers[3].id } });
  await call('POST', '/api/admin/op', { token: a, body: { op: 'setStatus', status: 'live' } });
  r = await call('POST', '/api/join', { body: { code, name: 'Finn', password: 'secret12' } });
  assert(r.status === 409 && /geschlossen/.test(r.body.error), 'join after draft start refused');
  r = await call('POST', '/api/admin/op', { token: a, body: { op: 'addManager', name: 'Late', password: 'secret12' } });
  assert(r.status === 200 && league().managers.some(m => m.name === 'Late'), 'admin can still add someone late');
  return 'cap from pool (4), closed after start, admin can add late';
};

tests.draft_referee = async () => {
  const { tok, ids } = await liveLeague(['Ann', 'Ben']);
  let r = await call('POST', '/api/pick', { token: tok.Ben, body: { player: 'G2_TOP' } });
  assert(r.status === 409, 'out of turn refused');
  r = await call('POST', '/api/pick', { token: tok.Ann, body: { player: 'G2_TOP' } });
  assert(r.status === 200 && r.body.onTheClock === ids.Ben, 'legal pick, clock moves');
  r = await call('POST', '/api/pick', { token: tok.Ben, body: { player: 'G2_TOP' } });
  assert(r.status === 422, 'taken player refused');
  r = await call('POST', '/api/pick', { token: tok.Ben, body: { player: 'NOPE' } });
  assert(r.status === 422, 'unknown player refused');
  assert(/Ann pickt G2 TOP/.test(gh.messages('league.json').pop()), 'commit message names the manager and the player');
  return 'turn, taken, unknown enforced; readable commit messages';
};

tests.simultaneous_and_race = async () => {
  const { tok } = await liveLeague(['Ann', 'Ben']);
  const [x, y] = await Promise.all([
    call('POST', '/api/pick', { token: tok.Ann, body: { player: 'G2_TOP' } }),
    call('POST', '/api/pick', { token: tok.Ann, body: { player: 'FNC_TOP' } })]);
  assert([x, y].filter(r => r.status === 200).length === 1, 'double-click: exactly one pick');
  assert(league().draft.picks.length === 1, 'file holds one pick');
  // force a lost race: someone else writes between our read and our write
  const orig = gh.handle; let armed = true;
  gh.handle = async (url, init) => {
    const res = await orig(url, init);
    if (armed && url.includes('/contents/league.json') && (!init || !init.method)) {
      armed = false;
      const l = league(); l.name = 'edited meanwhile';
      const cur = gh.files.get('league.json');
      cur.push({ sha: 'c' + 'f'.repeat(39), text: JSON.stringify(l), message: 'meanwhile', date: new Date().toISOString() });
    }
    return res;
  };
  const r = await call('POST', '/api/pick', { token: tok.Ben, body: { player: 'FNC_MID' } });
  gh.handle = orig;
  assert(gh.stats.conflicts >= 1 && r.status === 200, 'recovered from a real 409');
  assert(league().name === 'edited meanwhile' && league().draft.picks.length === 2, 'both edits survive');
  return `one winner on double-click; real 409 (${gh.stats.conflicts}x) recovered without losing the other edit`;
};

tests.admin_interventions = async () => {
  const { a, tok, ids } = await liveLeague(['Ann', 'Ben', 'Cem']);
  const op = body => call('POST', '/api/admin/op', { token: a, body });
  await call('POST', '/api/pick', { token: tok.Ann, body: { player: 'G2_TOP' } });
  // a member's pick "didn't work" -> admin picks for whoever is on the clock
  let r = await op({ op: 'pickFor', player: 'FNC_TOP' });
  assert(r.status === 200 && league().draft.picks[1].manager === ids.Ben && league().draft.picks[1].by === 'admin', 'pick for on-clock manager');
  // wrong player picked -> replace it in place
  r = await op({ op: 'replacePick', index: 1, player: 'FNC_MID' });
  assert(r.status === 200 && league().draft.picks[1].player === 'FNC_MID', 'replace pick');
  r = await op({ op: 'replacePick', index: 1, player: 'G2_TOP' });
  assert(r.status === 400, 'cannot replace with a player someone owns');
  // undo
  r = await op({ op: 'undoPick' });
  assert(r.status === 200 && league().draft.picks.length === 1, 'undo');
  // out of turn only with force
  r = await op({ op: 'pickFor', manager: ids.Cem, player: 'KC_TOP' });
  assert(r.status === 409, 'out-of-turn admin pick needs force');
  r = await op({ op: 'pickFor', manager: ids.Cem, player: 'KC_TOP', force: true });
  assert(r.status === 200, 'forced out-of-turn pick');
  // removing a manager with picks needs force
  r = await op({ op: 'removeManager', manager: ids.Cem });
  assert(r.status === 400, 'remove with picks needs force');
  // points, names, order, announcement
  assert((await op({ op: 'adjust', manager: ids.Ann, pts: -5, reason: 'zu spät' })).status === 200, 'adjust');
  assert((await op({ op: 'renameManager', manager: ids.Ben, name: 'Bea' })).status === 200, 'rename');
  assert((await op({ op: 'renameManager', manager: ids.Ben, name: 'a' })).status === 400, 'rename validates');
  assert((await op({ op: 'announce', text: 'Draft 20 Uhr' })).status === 200 && league().announcement.text === 'Draft 20 Uhr', 'announce');
  assert((await op({ op: 'setOrder', order: [ids.Cem, ids.Ben, ids.Ann] })).status === 400, 'reorder after picks needs force');
  assert((await op({ op: 'bogus' })).status === 400, 'unknown op refused');
  await op({ op: 'resetDraft' });
  const after = league();
  assert(!after.draft.picks.length && !after.adjustments.length && after.draft.status === 'lobby' && after.managers.length === 3, 'reset clears the season, keeps members');
  return 'pick-for, replace, undo, forced pick, guarded remove, adjust, rename, announce, guarded reorder';
};

tests.passwords_and_sessions = async () => {
  const { a, tok, ids } = await liveLeague(['Ann', 'Ben']);
  const op = body => call('POST', '/api/admin/op', { token: a, body });
  // forgot password -> admin sets a new one, old sessions die
  let r = await op({ op: 'setPassword', manager: ids.Ann, password: 'brand-new-pw' });
  assert(r.status === 200, 'set password');
  assert((await call('GET', '/api/state', { token: tok.Ann })).status === 401, 'old session revoked');
  assert((await call('POST', '/api/login', { body: { name: 'Ann', password: 'secret-Ann' } })).status === 401, 'old password dead');
  assert((await call('POST', '/api/login', { body: { name: 'Ann', password: 'brand-new-pw' } })).status === 200, 'new password works');
  // kick
  assert((await call('GET', '/api/state', { token: tok.Ben })).status === 200, 'B logged in');
  await op({ op: 'kick', manager: ids.Ben });
  assert((await call('GET', '/api/state', { token: tok.Ben })).status === 401, 'kick logs out');
  // a member token is not an admin token
  assert((await call('GET', '/api/admin/state', { token: tok.Ben })).status === 401, 'member cannot use admin api');
  assert((await call('POST', '/api/admin/login', { body: { username: 'admin', password: 'guess' } })).status === 401, 'wrong admin password');
  assert((await call('POST', '/api/admin/login', { body: { username: 'root', password: ADMIN_PW } })).status === 401, 'wrong admin name');
  assert((await call('POST', '/api/admin/login', { body: { username: ' ADMIN ', password: ADMIN_PW } })).status === 200, 'admin name case/space-insensitive');
  assert((await call('POST', '/api/admin/op', { token: a, body: { op: 'renameManager', manager: ids.Ann, name: 'Admin' } })).status === 400, 'nobody can be renamed to admin');
  return 'reset password revokes sessions, kick, member≠admin, admin password checked';
};

tests.validation_guard_and_restore = async () => {
  const { a, tok } = await liveLeague(['Ann', 'Ben']);
  await call('POST', '/api/pick', { token: tok.Ann, body: { player: 'G2_TOP' } });
  const good = league();
  const shaGood = (await call('GET', '/api/admin/history', { token: a })).body.commits[0].sha;
  // a broken raw edit is refused...
  const broken = JSON.parse(JSON.stringify(good)); broken.draft.picks.push({ manager: 'ghost', player: 'G2_TOP' });
  let r = await call('POST', '/api/admin/op', { token: a, body: { op: 'setRaw', league: broken } });
  assert(r.status === 400 && /Ungültig/.test(r.body.error), 'broken raw edit refused: ' + r.body.error);
  // ...unless forced (last resort) - and then history brings it back
  r = await call('POST', '/api/admin/op', { token: a, body: { op: 'setRaw', league: broken, force: true } });
  assert(r.status === 200 && league().draft.picks.length === 2, 'forced broken edit written');
  const st = (await call('GET', '/api/admin/state', { token: a })).body;
  assert(st.validation.errors.length >= 1, 'admin state reports the breakage');
  r = await call('POST', '/api/admin/op', { token: a, body: { op: 'restore', sha: shaGood } });
  assert(r.status === 200 && JSON.stringify(league()) === JSON.stringify(good), 'restored exactly');
  assert(/zurückgesetzt auf/.test(gh.messages('league.json').pop()), 'restore is itself a commit (undoable)');
  // validator fixes can be applied directly
  const l = league(); l.draft.order.push(l.draft.order[0]);
  await call('POST', '/api/admin/op', { token: a, body: { op: 'setRaw', league: l, force: true } });
  const fix = (await call('GET', '/api/admin/state', { token: a })).body.validation.errors.find(e => e.fix);
  r = await call('POST', '/api/admin/op', { token: a, body: { op: 'fix', fix: Object.assign({ force: true }, fix.fix) } });
  assert(r.status === 200 && !(await call('GET', '/api/admin/state', { token: a })).body.validation.errors.length, 'one-click fix: ' + JSON.stringify(r.body));
  return 'broken writes refused, forced ones detected, exact restore from history, one-click fixes';
};

tests.timer_autopick = async () => {
  const { a, tok, ids } = await liveLeague(['Ann', 'Ben']);
  await call('POST', '/api/admin/op', { token: a, body: { op: 'setTimer', mode: 'auto', seconds: 30 } });
  await env.LEAGUE.put(`queue:${ids.Ann}`, JSON.stringify(['TH_SUP']));
  const realNow = Date.now;
  Date.now = () => realNow() + 31000;               // A sleeps through the clock
  let st = await call('GET', '/api/state', { token: tok.Ben });
  assert(st.body.autoPicked && st.body.autoPicked.player === 'TH_SUP', 'auto-pick takes the queue first: ' + JSON.stringify(st.body.autoPicked));
  Date.now = () => realNow() + 62000 + 31000;       // B sleeps too, empty queue
  st = await call('GET', '/api/state', { token: tok.Ann });
  Date.now = realNow;
  const p = league().draft.picks;
  assert(p.length === 2 && p[1].by === 'auto' && p[1].player.startsWith('G2_'), 'then best available by points: ' + (p[1] && p[1].player));
  return 'timer runs out -> queue first, else best available; marked [auto]';
};

tests.transfers = async () => {
  const { a, tok, ids } = await liveLeague(['Ann', 'Ben']);
  const rules = r => call('POST', '/api/admin/op', { token: a, body: { op: 'setTradeRules', rules: r } });
  const pickFor = pl => call('POST', '/api/admin/op', { token: a, body: { op: 'pickFor', player: pl } });
  // snake for two: Ann, Ben, Ben, Ann, ... - legal for both (<=2 per team)
  const order = ['G2_TOP', 'FNC_TOP', 'FNC_JNG', 'G2_JNG', 'KC_MID', 'MKOI_MID', 'MKOI_BOT', 'KC_BOT', 'TH_SUP', 'VIT_SUP', 'TH_TOP', 'VIT_TOP'];
  for (const p of order) { const r = await pickFor(p); assert(r.status === 200, 'draft ' + p + ': ' + r.body.error); }
  assert(league().draft.completed, 'draft locked when full');
  const trade = (who, body) => call('POST', '/api/trade', { token: tok[who], body });

  let r = await trade('Ann', { action: 'propose', to: ids.Ben, give: ['G2_TOP'], get: ['FNC_TOP'] });
  assert(r.status === 403, 'trades off by default');
  // enabled, but no window entered -> closed
  await rules({ enabled: true, freeAgents: true, perWeek: 1, mode: 'windows', windows: [] });
  r = await trade('Ann', { action: 'propose', to: ids.Ben, give: ['G2_TOP'], get: ['FNC_TOP'] });
  assert(r.status === 409 && /zu/.test(r.body.error), 'no window = closed: ' + r.body.error);
  // a window that is over, and one that opens later -> closed, says when
  const day = 864e5, iso = x => new Date(x).toISOString();
  await rules({ enabled: true, freeAgents: true, perWeek: 1, windows: [
    { from: iso(Date.now() - 9 * day), to: iso(Date.now() - 2 * day), label: 'vorbei' },
    { from: iso(Date.now() + 5 * day), to: iso(Date.now() + 9 * day), label: 'spaeter' }] });
  r = await trade('Ann', { action: 'propose', to: ids.Ben, give: ['G2_TOP'], get: ['FNC_TOP'] });
  assert(r.status === 409 && /nächste öffnet/.test(r.body.error), 'tells when it opens: ' + r.body.error);
  // the admin's window check rejects nonsense
  assert((await rules({ enabled: true, windows: [{ from: iso(Date.now() + day), to: iso(Date.now()) }] })).status === 400, 'from after to refused');
  // open window now
  await rules({ enabled: true, freeAgents: true, perWeek: 1, windows: [{ from: iso(Date.now() - day), to: iso(Date.now() + day), label: 'offen' }] });
  r = await trade('Ann', { action: 'propose', to: ids.Ben, give: ['FNC_TOP'], get: ['G2_TOP'] });
  assert(r.status === 400, 'cannot offer players you do not own');
  // roster rules: Ann gives her only SUP for a TOP -> refused
  r = await trade('Ann', { action: 'propose', to: ids.Ben, give: ['TH_SUP'], get: ['FNC_TOP'] });
  assert(r.status === 422 && /keine SUP/.test(r.body.error), 'trading away the only SUP refused: ' + r.body.error);
  r = await trade('Ann', { action: 'propose', to: ids.Ben, give: ['G2_TOP'], get: ['FNC_TOP'] });
  assert(r.status === 200, 'legal trade proposed: ' + r.body.error);
  const id = r.body.trade.id;
  assert((await trade('Ann', { action: 'respond', id, accept: true })).status === 403, 'proposer cannot accept');
  r = await trade('Ben', { action: 'respond', id, accept: true });
  assert(r.status === 200 && r.body.trade.status === 'accepted', 'two managers are enough');
  const ros = globalThis.LECScoring.rosters(league());
  assert(ros[ids.Ann].includes('FNC_TOP') && ros[ids.Ben].includes('G2_TOP'), 'rosters swapped');
  // free agents: one per week, must be free, roster rules apply
  r = await trade('Ann', { action: 'freeAgent', out: 'VIT_TOP', in: 'SK_TOP' });
  assert(r.status === 400, 'unknown player refused');
  r = await trade('Ann', { action: 'freeAgent', out: 'VIT_TOP', in: 'G2_TOP' });
  assert(r.status === 409 && /nicht mehr frei/.test(r.body.error), 'owned player refused');
  r = await trade('Ann', { action: 'freeAgent', out: 'TH_SUP', in: 'MKOI_TOP' });
  assert(r.status === 422, 'free agent that drops the only SUP refused');
  r = await trade('Ann', { action: 'freeAgent', out: 'VIT_TOP', in: 'MKOI_TOP' });
  assert(r.status === 200 && globalThis.LECScoring.rosters(league())[ids.Ann].includes('MKOI_TOP'), 'free agent picked up: ' + r.body.error);
  r = await trade('Ann', { action: 'freeAgent', out: 'MKOI_TOP', in: 'MKOI_JNG' });
  assert(r.status === 409 && /Woche/.test(r.body.error), 'second pickup this week refused: ' + r.body.error);
  assert(/holt MKOI TOP für VIT TOP/.test(gh.messages('league.json').pop()), 'readable commit message');
  return 'off by default, closed without window, says when it opens, roster rules, 2 managers suffice, free agents 1/week';
};

tests.waivers = async () => {
  const { a, tok, ids } = await liveLeague(['Ann', 'Ben', 'Cem']);
  const S = globalThis.LECScoring;
  const idx = new Map(PLAYERS.players.map(p => [p.id, p]));
  const op = b => call('POST', '/api/admin/op', { token: a, body: b });
  const trade = (who, b) => call('POST', '/api/trade', { token: tok[who], body: b });
  for (;;) {
    const L = league(), m = S.currentPicker(L);
    if (!m) break;
    const lvl = S.relaxLevel(L, idx, m);
    const r = await op({ op: 'pickFor', player: PLAYERS.players.find(p => !S.pickError(L, idx, m, p.id, lvl)).id });
    assert(r.status === 200, 'draft: ' + r.body.error);
  }
  const base = { enabled: false, freeAgents: true, perWeek: 1, mode: 'always', rosterRules: true, teamLimit: false };
  let r = await op({ op: 'setTradeRules', rules: Object.assign({}, base, { faMode: 'waiver', waiver: { days: [], time: '03:00' } }) });
  assert(r.status === 400, 'no waiver day refused');
  r = await op({ op: 'setTradeRules', rules: Object.assign({}, base, { faMode: 'waiver', waiver: { days: [1, 2, 3, 4, 5, 6, 7], time: '25:00' } }) });
  assert(r.status === 400, 'bad time refused');
  r = await op({ op: 'setTradeRules', rules: Object.assign({}, base, { faMode: 'waiver', waiver: { days: [1, 2, 3, 4, 5, 6, 7], time: '03:00', order: 'reverse' } }) });
  assert(r.status === 200, 'waiver rules: ' + r.body.error);

  const L = league(), ros = S.rosters(L), own = S.ownership(L);
  const free = PLAYERS.players.filter(p => !own.has(p.id));
  const X = free.find(p => ['Ann', 'Ben'].every(n => ros[ids[n]].some(q => idx.get(q).role === p.role)));
  const outOf = (n, role) => ros[ids[n]].find(q => idx.get(q).role === role);
  const other = (n, not) => free.find(p => p.id !== X.id && p.id !== not && ros[ids[n]].some(q => idx.get(q).role === p.role));
  const Y = other('Ben'), Z = other('Ann', Y.id);
  r = await trade('Ann', { action: 'freeAgent', out: outOf('Ann', X.role), in: X.id });
  assert(r.status === 409 && /Waiver/.test(r.body.error), 'instant pickup refused in waiver mode');
  for (const [n, P] of [['Ann', X], ['Ann', Z], ['Ben', X], ['Ben', Y]]) {
    r = await trade(n, { action: 'claim', out: outOf(n, P.role), in: P.id });
    assert(r.status === 200, `claim ${n} ${P.id}: ${r.body.error}`);
  }
  r = await trade('Ann', { action: 'claim', out: outOf('Ann', X.role), in: X.id });
  assert(r.status === 409, 'duplicate claim refused');
  const st = await call('GET', '/api/state', { token: tok.Ann });
  assert(st.body.claims.length === 2 && st.body.nextWaiver, 'state shows my claims + next run');
  const order = S.waiverOrder(league(), STATS, idx).filter(id => id === ids.Ann || id === ids.Ben);
  r = await op({ op: 'runWaivers' });
  assert(r.status === 200 && /2 Wechsel/.test(r.body.message), 'run: ' + JSON.stringify(r.body));
  const after = league(), own2 = S.ownership(after);
  assert(own2.get(X.id) === order[0], 'the contested player went to the manager with priority');
  const per = id => after.swaps.filter(s => s.manager === id && s.by === 'waiver').length;
  assert(per(ids.Ann) === 1 && per(ids.Ben) === 1, 'winner hit the weekly limit, loser got their 2nd claim');
  assert(!(await env.LEAGUE.get(`claims:${ids.Ann}`)) && !(await env.LEAGUE.get(`claims:${ids.Ben}`)), 'claims cleared after the run');
  assert(/waiver: 2 Wechsel/.test(gh.messages('league.json').pop()), 'one commit for the whole run');

  // rolling order: the winner moves to the back
  await op({ op: 'setTradeRules', rules: Object.assign({}, base, { perWeek: 0, faMode: 'waiver', waiver: { days: [1, 2, 3, 4, 5, 6, 7], time: '03:00', order: 'rolling' } }) });
  const L2 = league(), ros2 = S.rosters(L2), own3 = S.ownership(L2);
  const F = PLAYERS.players.find(p => !own3.has(p.id) && ['Ann', 'Ben', 'Cem'].every(n => ros2[ids[n]].some(q => idx.get(q).role === p.role)));
  for (const n of ['Ann', 'Ben', 'Cem']) await trade(n, { action: 'claim', out: ros2[ids[n]].find(q => idx.get(q).role === F.role), in: F.id });
  const first = S.waiverOrder(league(), STATS, idx)[0];
  await op({ op: 'runWaivers' });
  const L3 = league();
  assert(S.ownership(L3).get(F.id) === first, 'rolling: first in order wins');
  assert(L3.waiverOrder[L3.waiverOrder.length - 1] === first, 'rolling: winner moves to the back');
  return 'contested claim goes by priority, loser gets 2nd claim, weekly limit, claims cleared, one commit; rolling order rotates';
};

tests.scheduler = async () => {
  const S = globalThis.LECScoring;
  const { a, tok, ids } = await liveLeague(['Ann', 'Ben']);
  const op = b => call('POST', '/api/admin/op', { token: a, body: b });
  const idx = new Map(PLAYERS.players.map(p => [p.id, p]));
  for (;;) {
    const L = league(), m = S.currentPicker(L);
    if (!m) break;
    const lvl = S.relaxLevel(L, idx, m);
    await op({ op: 'pickFor', player: PLAYERS.players.find(p => !S.pickError(L, idx, m, p.id, lvl)).id });
  }
  // a waiver slot two minutes ago (German time) -> the cron runs it once
  const bp = S.berlinParts(Date.now() - 120000);
  const hhmm = String(bp.h).padStart(2, '0') + ':' + String(bp.mi).padStart(2, '0');
  await op({ op: 'setTradeRules', rules: { freeAgents: true, perWeek: 0, mode: 'always', rosterRules: true, teamLimit: false, faMode: 'waiver', waiver: { days: [1, 2, 3, 4, 5, 6, 7], time: hhmm } } });
  const L = league(), ros = S.rosters(L), own = S.ownership(L);
  const F = PLAYERS.players.find(p => !own.has(p.id) && ros[ids.Ann].some(q => idx.get(q).role === p.role));
  await call('POST', '/api/trade', { token: tok.Ann, body: { action: 'claim', out: ros[ids.Ann].find(q => idx.get(q).role === F.role), in: F.id } });
  const ctx = { waitUntil() {} };
  await worker.scheduled({}, env, ctx);
  assert(S.ownership(league()).get(F.id) === ids.Ann, 'cron ran the due waiver slot');
  const commits = gh.messages('league.json').length;
  await worker.scheduled({}, env, ctx);
  assert(gh.messages('league.json').length === commits, 'same slot never runs twice');

  // draft appointment on a fresh league: reminder once, then auto-start
  await setup();
  const b = await liveLeague(['Ann', 'Ben']);
  await call('POST', '/api/admin/op', { token: b.a, body: { op: 'resetDraft' } });
  let r = await call('POST', '/api/admin/op', { token: b.a, body: { op: 'setDraftSchedule', at: new Date(Date.now() + 30 * 60000).toISOString(), reminderMinutes: 60, autoStart: true } });
  assert(r.status === 200, 'schedule: ' + r.body.error);
  await worker.scheduled({}, env, ctx);
  assert(await env.LEAGUE.get('remind:' + league().draft.scheduledAt), 'reminder fired inside the 60 min window');
  assert(league().draft.status === 'lobby', 'not started early');
  await call('POST', '/api/admin/op', { token: b.a, body: { op: 'setDraftSchedule', at: new Date(Date.now() - 60000).toISOString(), reminderMinutes: 60, autoStart: true } });
  await worker.scheduled({}, env, ctx);
  assert(league().draft.status === 'live', 'auto-started at the appointment');
  r = await call('POST', '/api/admin/op', { token: b.a, body: { op: 'setScoring', scoring: { kill: 3, death: -1, assist: 1.5, cs10: 0.02, win: 2, bonus: { enabled: true, threshold: 10, points: 2 } } } });
  assert(r.status === 200 && league().scoring.bonus.enabled, 'bonus saved');
  r = await call('POST', '/api/admin/op', { token: b.a, body: { op: 'setScoring', scoring: { kill: 3, death: -1, assist: 1.5, cs10: 0.02, win: 2, bonus: { enabled: true, threshold: 0, points: 2 } } } });
  assert(r.status === 400, 'bonus threshold 0 refused');
  return 'due waiver slot runs once via cron; draft reminder in its window; auto-start at the appointment; bonus validated';
};

async function draftAll(a) {
  const S = globalThis.LECScoring, idx = new Map(PLAYERS.players.map(p => [p.id, p]));
  for (;;) {
    const L = league(), m = S.currentPicker(L);
    if (!m) break;
    const lvl = S.relaxLevel(L, idx, m);
    const r = await call('POST', '/api/admin/op', { token: a, body: { op: 'pickFor', player: PLAYERS.players.find(p => !S.pickError(L, idx, m, p.id, lvl)).id } });
    if (r.status !== 200) throw new Error('draft: ' + r.body.error);
  }
}

tests.lineups = async () => {
  const S = globalThis.LECScoring, idx = new Map(PLAYERS.players.map(p => [p.id, p]));
  const { a, tok, ids } = await liveLeague(['Ann', 'Ben']);
  let r = await call('POST', '/api/admin/op', { token: a, body: { op: 'setRoster', roster: { slots: ROLES, perRole: 2, maxPerTeam: 3 }, force: true } });
  assert(r.status === 200 && /2 pro Rolle/.test(r.body.message), 'perRole roster: ' + JSON.stringify(r.body));
  await draftAll(a);
  const ros = S.rosters(league())[ids.Ann];
  assert(ros.length === 10, 'Ann holds 10');
  await call('POST', '/api/admin/op', { token: a, body: { op: 'setLineupRules', enabled: true, captain: 1.5 } });
  const soon = new Date(Date.now() + 864e5).toISOString(), past = new Date(Date.now() - 864e5).toISOString();
  SCHEDULE = { events: [{ match: 'W1', start: past, state: 'completed', block: 'Week 1', tournament: 'sp', teams: [] },
                        { match: 'W2', start: soon, state: 'unstarted', block: 'Week 2', tournament: 'sp', teams: [] }] };
  const byRole = r0 => ros.filter(id => idx.get(id).role === r0);
  const starters = ROLES.map(r0 => byRole(r0)[0]);
  const set = b => call('POST', '/api/lineup', { token: tok.Ann, body: b });
  r = await set({ block: 'sp|Week 2', starters, captain: starters[2], vice: starters[0] });
  assert(r.status === 200, 'lineup saved: ' + r.body.error);
  assert(league().lineups[ids.Ann]['sp|Week 2'].captain === starters[2], 'stored');
  r = await set({ block: 'sp|Week 2', starters: [byRole('TOP')[0], byRole('TOP')[1], starters[2], starters[3], starters[4]], captain: starters[2], vice: starters[3] });
  assert(r.status === 400 && /Rolle/.test(r.body.error), 'two TOPs refused');
  r = await set({ block: 'sp|Week 2', starters, captain: starters[2], vice: starters[2] });
  assert(r.status === 400, 'captain = vice refused');
  r = await set({ block: 'sp|Week 1', starters, captain: starters[2], vice: starters[0] });
  assert(r.status === 409 && /gesperrt/.test(r.body.error), 'started week locked');
  r = await call('POST', '/api/lineup', { token: tok.Ben, body: { block: 'sp|Week 2', starters, captain: starters[2], vice: starters[0] } });
  assert(r.status === 400, 'cannot line up someone else\'s players');
  return '10-man roster 2 per role, lineup saved, wrong roles / captain=vice / locked week / foreign players refused';
};

tests.pickem_hidden_until_lock = async () => {
  const { a, tok, ids } = await liveLeague(['Ann', 'Ben']);
  const lockSoon = new Date(Date.now() + 3600e3).toISOString();
  let r = await call('POST', '/api/admin/op', { token: a, body: { op: 'pickemOpen', split: 'sp', lockAt: lockSoon,
    questions: [{ type: 'champion', points: 10 }, { type: 'longestGame', points: 5 }, { type: 'manualChamp', points: 3, label: 'Meistgebannt' }] } });
  assert(r.status === 200, 'open: ' + r.body.error);
  r = await call('POST', '/api/admin/op', { token: a, body: { op: 'pickemOpen', split: 'sp', questions: [{ type: 'nonsense', points: 1 }] } });
  assert(r.status === 400, 'unknown question type refused');
  await call('POST', '/api/pickem', { token: tok.Ann, body: { split: 'sp', picks: { q1: 'G2', q2: '41', q3: 'Ahri', bogus: 'x' } } });
  await call('POST', '/api/pickem', { token: tok.Ben, body: { split: 'sp', picks: { q1: 'KC' } } });
  let s = (await call('GET', '/api/pickem', { token: tok.Ben })).body.pickems.sp;
  assert(s.mine.q1 === 'KC' && !s.mine.q2 && !s.revealed, 'Ben sees only his own picks');
  assert(!JSON.stringify(league()).includes('"G2"'), 'Ann\'s picks are not in the league file before the lock');
  // lock passes -> the cron reveals
  await call('POST', '/api/admin/op', { token: a, body: { op: 'pickemOpen', split: 'sp', lockAt: new Date(Date.now() - 1000).toISOString(),
    questions: [{ type: 'champion', points: 10 }, { type: 'longestGame', points: 5 }, { type: 'manualChamp', points: 3, label: 'Meistgebannt' }] } });
  await worker.scheduled({}, env, { waitUntil() {} });
  const pe = league().pickems.sp;
  assert(pe.revealed && pe.picks[ids.Ann].q1 === 'G2' && pe.picks[ids.Ben].q1 === 'KC' && !pe.picks[ids.Ann].bogus, 'revealed at the lock, unknown keys dropped');
  r = await call('POST', '/api/pickem', { token: tok.Ann, body: { split: 'sp', picks: { q1: 'KC' } } });
  assert(r.status === 409, 'no changes after the lock');
  r = await call('POST', '/api/admin/op', { token: a, body: { op: 'pickemAnswer', split: 'sp', qid: 'q3', answer: 'Ahri' } });
  assert(r.status === 200 && league().pickems.sp.questions[2].answer === 'Ahri', 'manual answer');
  r = await call('POST', '/api/admin/op', { token: a, body: { op: 'pickemAnswer', split: 'sp', qid: 'q1', answer: 'G2' } });
  assert(r.status === 400, 'automatic questions take no manual answer');
  return 'picks private in KV, unknown types refused, revealed by the cron at the lock, frozen after, manual answers';
};

tests.pickem_push_once = async () => {
  const { a, tok, ids } = await liveLeague(['Ann', 'Ben']);
  const kv = k => env.LEAGUE.get(k);
  const open = lockMs => call('POST', '/api/admin/op', { token: a, body: { op: 'pickemOpen', split: 'sp', lockAt: new Date(Date.now() + lockMs).toISOString(), questions: [{ type: 'champion', points: 10 }] } });
  const cron = () => worker.scheduled({}, env, { waitUntil() {} });
  await open(48 * 3600e3);
  await cron();
  assert(await kv('pkn:sp:open') && !(await kv('pkn:sp:24h')), 'opening announced, no reminder yet');
  await call('POST', '/api/pickem', { token: tok.Ann, body: { split: 'sp', picks: { q1: 'G2' } } });
  await open(12 * 3600e3);       // lock moves within 24 h
  await cron(); await cron();
  assert(await kv('pkn:sp:24h'), 'reminder flagged once');
  assert(await kv(`pick:sp:${ids.Ann}`) && !(await kv(`pick:sp:${ids.Ben}`)), 'only Ben still owes tips');
  await call('POST', '/api/admin/op', { token: a, body: { op: 'pickemOpen', split: 'sp2', lockAt: new Date(Date.now() + 3600e3).toISOString(), questions: [{ type: 'champion', points: 10 }] } });
  await cron();
  assert(await kv('pkn:sp2:open') && await kv('pkn:sp2:24h'), 'opened late: one message, no separate reminder');
  return 'open push once, 24 h reminder once (only to managers without tips), late opening sends a single message';
};

tests.chat = async () => {
  const { a, tok, ids } = await liveLeague(['Ann', 'Ben']);
  let r = await call('POST', '/api/chat', { token: tok.Ann, body: { text: '  hallo zusammen  ' } });
  assert(r.status === 200 && r.body.message.t === 'hallo zusammen' && r.body.message.m === ids.Ann, 'post: ' + JSON.stringify(r.body));
  const first = r.body.message.id;
  r = await call('POST', '/api/chat', { token: tok.Ann, body: { text: 'spam' } });
  assert(r.status === 429, 'two lines within 2 s refused');
  r = await call('POST', '/api/chat', { token: tok.Ben, body: { text: 'x'.repeat(900) } });
  assert(r.status === 200 && r.body.message.t.length === 500, 'cut to 500 chars');
  const benMsg = r.body.message.id;
  r = await call('POST', '/api/chat', { token: tok.Ben, body: { text: '   ' } });
  assert(r.status === 400, 'empty refused');
  r = await call('GET', '/api/chat');
  assert(r.status === 401, 'chat needs a login');
  const st = (await call('GET', '/api/state', { token: tok.Ann })).body;
  assert(st.chatLast && st.chatLast.id === benMsg, 'state carries the newest chat id');
  r = await call('DELETE', '/api/chat', { token: tok.Ben, body: { id: first } });
  assert(r.status === 403, "cannot delete someone else's line");
  r = await call('DELETE', '/api/chat', { token: tok.Ann, body: { id: first } });
  assert(r.status === 200, 'delete own line');
  r = await call('POST', '/api/admin/chat', { token: a, body: { text: 'Draft Sonntag 20 Uhr' } });
  assert(r.status === 200 && r.body.message.m === 'admin', 'admin posts as Admin');
  r = await call('DELETE', '/api/admin/chat', { token: a, body: { id: benMsg } });
  assert(r.status === 200, 'admin deletes any line');
  const list = (await call('GET', '/api/chat', { token: tok.Ben })).body;
  assert(list.messages.length === 1 && list.messages[0].m === 'admin' && !list.muted, 'one admin line left: ' + JSON.stringify(list));
  await call('POST', '/api/chat/mute', { token: tok.Ben, body: { mute: true } });
  assert((await call('GET', '/api/chat', { token: tok.Ben })).body.muted === true, 'mute stored');
  r = await call('POST', '/api/admin/chat', { token: tok.Ann, body: { text: 'fake admin' } });
  assert(r.status === 401, 'members cannot use the admin chat');
  return 'post/trim/500 cap, 2 s rate limit, login needed, chatLast in state, own delete only, admin post + delete any, mute';
};

tests.lineup_reminder_and_recap = async () => {
  const X = await import('./src/extras.js');
  const { a } = await liveLeague(['Ann', 'Ben']);
  await call('POST', '/api/admin/op', { token: a, body: { op: 'setRoster', roster: { slots: ROLES, perRole: 2, maxPerTeam: 3 }, force: true } });
  await draftAll(a);
  const now = Date.parse('2026-08-08T10:00:00Z');                   // Saturday, 12:00 in Berlin
  const iso = ms => new Date(ms).toISOString();
  SCHEDULE = { events: [
    { match: 'x', start: iso(now - 7 * 864e5), state: 'completed', block: 'Week 1', tournament: 'sp', teams: [{ code: 'G2' }, { code: 'FNC' }] },
    { match: 'W2', start: iso(now + 2 * 3600e3), state: 'unstarted', block: 'Week 2', tournament: 'sp', teams: [{ code: 'G2' }, { code: 'FNC' }] }] };
  let r = await X.lineupReminders(env, league(), now);
  assert(r === null, 'lineups off: no reminder');
  await call('POST', '/api/admin/op', { token: a, body: { op: 'setLineupRules', enabled: true, captain: 1.5 } });
  r = await X.lineupReminders(env, league(), now - 2 * 3600e3);
  assert(r === null && !(await env.LEAGUE.get('lrem:sp|Week 2')), '4 h before the lock: too early, nothing flagged');
  r = await X.lineupReminders(env, league(), now);
  assert(r && r.key === 'sp|Week 2' && r.sent.length === 2, 'both have starters from teams without a match: ' + JSON.stringify(r));
  assert((await X.lineupReminders(env, league(), now + 60e3)) === null, 'once per week');
  // recap: week 1 ended long ago -> never announced; a fresh one at a civil hour -> once
  assert((await X.recapPush(env, league(), now)) === null, 'old week not announced');
  SCHEDULE.events[1].state = 'completed';
  const night = now + 2 * 3600e3 + 11 * 3600e3;                     // 23:00 UTC = 01:00 Berlin
  assert((await X.recapPush(env, league(), night)) === null, 'not at night');
  const morning = now + 2 * 3600e3 + 20 * 3600e3;                   // 08:00 UTC = 10:00 Berlin
  assert((await X.recapPush(env, league(), morning)) === 'sp|Week 2', 'announced in the morning');
  assert((await X.recapPush(env, league(), morning + 60e3)) === null, 'only once');
  return 'reminder only with lineups on, only within 3 h, flags starters of idle teams, once; recap once, daytime only, never for old weeks';
};

tests.hall_of_fame = async () => {
  const X = await import('./src/extras.js');
  const { a } = await liveLeague(['Ann', 'Ben']);
  await draftAll(a);
  SCHEDULE = { events: [{ match: 'x', start: '2026-08-01T15:00:00Z', state: 'completed', block: 'Week 1', tournament: 'sp', teams: [{ code: 'G2' }, { code: 'FNC' }] }] };
  STATS.games.forEach(g => { g.tournament = 'sp'; });
  try {
    SEASON = { season: 2026, tournaments: [{ slug: 'sp', lastMatch: new Date(Date.now() - 864e5).toISOString(), done: true }] };
    assert((await X.hallCron(env, league())) === null, 'drafted after the split ended: no fame for history');
    const l = league(); l.draft.startedAt = '2026-01-01T00:00:00Z';
    await call('POST', '/api/admin/op', { token: a, body: { op: 'setRaw', league: l } });
    const r = await X.hallCron(env, league());
    assert(r && r.changed && r.due[0] === 'sp', 'split frozen: ' + JSON.stringify(r));
    const h = league().hall;
    assert(h.sp.table.length === 2 && h.sp.table[0].pts >= h.sp.table[1].pts, 'table stored');
    assert(h.season_2026 && h.season_2026.table.length === 2, 'season entry once all splits are in');
    assert((await X.hallCron(env, league())) === null, 'nothing twice');
    let q = await call('POST', '/api/admin/hall', { token: a, body: { split: 'sp', action: 'delete' } });
    assert(q.status === 200 && !league().hall.sp, 'admin removes an entry');
    q = await call('POST', '/api/admin/hall', { token: a, body: { split: 'sp' } });
    assert(q.status === 200 && league().hall.sp, 'admin rebuilds an entry');
    await call('POST', '/api/admin/op', { token: a, body: { op: 'resetDraft', force: true } });
    assert(league().hall.sp, 'a draft reset keeps the hall of fame');
  } finally { STATS.games.forEach(g => { delete g.tournament; }); }
  return 'no fame for replayed history, split + season frozen once, admin delete/rebuild, survives a draft reset';
};

tests.backups = async () => {
  const B = await import('./src/backup.js');
  const { a, tok, ids } = await liveLeague(['Ann', 'Ben']);
  await call('POST', '/api/chat', { token: tok.Ann, body: { text: 'vorher' } });
  await env.LEAGUE.put('pick:sp:' + ids.Ann, JSON.stringify({ q1: 'G2' }));
  await env.LEAGUE.put('queue:' + ids.Ben, JSON.stringify(['G2_MID']));
  // manual backup
  let r = await call('POST', '/api/admin/backup', { token: a, body: { action: 'create' } });
  assert(r.status === 200 && r.body.backup.id, 'create: ' + JSON.stringify(r.body));
  const id = r.body.backup.id;
  const list = (await call('GET', '/api/admin/backups', { token: a })).body.backups;
  assert(list.length === 1 && list[0].id === id && list[0].managers === 2 && list[0].chat === 1, 'listed with summary: ' + JSON.stringify(list));
  const full = (await call('GET', '/api/admin/backup?id=' + id, { token: a })).body;
  assert(full.v === 1 && full.league.managers.length === 2 && full.kv.tips['pick:sp:' + ids.Ann].q1 === 'G2' && full.kv.queues['queue:' + ids.Ben][0] === 'G2_MID', 'league + KV parts inside');
  const txt = JSON.stringify(full);
  assert(!/mgr:|session:|push:|pbkdf2|"invite"|"salt"|"iters"/i.test(txt) && !txt.includes('secret-Ann'), 'download: no password hashes, sessions, push or invite');
  assert((await call('GET', '/api/admin/backups')).status === 401 && (await call('GET', '/api/admin/backups', { token: tok.Ann })).status === 401, 'backups are admin-only');
  // things go wrong: a member removed, chat wiped, tips gone
  await call('POST', '/api/admin/op', { token: a, body: { op: 'removeManager', manager: ids.Ben, force: true } });
  await env.LEAGUE.put('chat', '[]'); await env.LEAGUE.delete('pick:sp:' + ids.Ann); await env.LEAGUE.put('pick:sp:junk', '{"q1":"KC"}');
  r = await call('POST', '/api/admin/backup', { token: a, body: { action: 'restore', id } });
  assert(r.status === 200 && /wiederhergestellt/.test(r.body.message), 'restore: ' + JSON.stringify(r.body));
  assert(league().managers.length === 2, 'league back');
  assert(JSON.parse(await env.LEAGUE.get('chat')).length === 1, 'chat back');
  assert(JSON.parse(await env.LEAGUE.get('pick:sp:' + ids.Ann)).q1 === 'G2' && !(await env.LEAGUE.get('pick:sp:junk')), 'tips back, stray tips removed');
  r = await call('POST', '/api/login', { body: { name: 'Ben', password: 'secret-Ben' } });
  assert(r.status === 200, 'a removed and restored member can log in again: ' + JSON.stringify(r.body));
  const after = (await call('GET', '/api/admin/backups', { token: a })).body.backups;
  assert(after.length === 2 && after.some(b => /vor Wiederherstellung/.test(b.label)), 'the state before the restore was saved first');
  // uploaded file
  r = await call('POST', '/api/admin/backup', { token: a, body: { action: 'restore', data: { hello: 1 } } });
  assert(r.status === 400, 'garbage file refused');
  await call('POST', '/api/admin/op', { token: a, body: { op: 'removeManager', manager: ids.Ben, force: true } });
  r = await call('POST', '/api/admin/backup', { token: a, body: { action: 'restore', data: full } });
  assert(r.status === 200 && r.body.noLogin.length === 1 && r.body.noLogin[0] === 'Ben', 'upload (no logins inside) names who needs a new password: ' + JSON.stringify(r.body));
  // cron: not before 05:00 Berlin, once a day, nothing if unchanged
  const day = Date.parse('2030-03-05T02:00:00Z');                    // 03:00 Berlin
  assert((await B.backupCron(env, day)) === null, 'not at night');
  const morning = Date.parse('2030-03-05T05:00:00Z');                // 06:00 Berlin
  const c1 = await B.backupCron(env, morning);
  assert(c1 && (c1.id || c1.skipped), 'morning run: ' + JSON.stringify(c1));
  assert((await B.backupCron(env, morning + 3600e3)) === null, 'once a day');
  const c3 = await B.backupCron(env, morning + 864e5);
  assert(c3 && c3.skipped === 'unverändert', 'next day without changes: skipped');
  await env.LEAGUE.put('queue:' + ids.Ann, JSON.stringify(['KC_TOP']));
  const c4 = await B.backupCron(env, morning + 2 * 864e5);
  assert(c4 && c4.id, 'next day with a change: new backup');
  const before = (await call('GET', '/api/admin/backups', { token: a })).body.backups;
  r = await call('POST', '/api/admin/backup', { token: a, body: { action: 'delete', id: before[0].id } });
  assert(r.status === 200 && (await call('GET', '/api/admin/backups', { token: a })).body.backups.length === before.length - 1, 'delete one backup');
  // retention
  for (let i = 0; i < 62; i++) await B.backupNow(env, 'x' + i);
  assert((await call('GET', '/api/admin/backups', { token: a })).body.backups.length === 60, 'newest 60 kept');
  return 'manual backup, summary, league+chat+tips+claims+queues inside, no secrets, admin-only, restore (with safety backup first), upload, garbage refused, cron daily from 05:00 only on change, keeps 60';
};

tests.faab = async () => {
  const S = globalThis.LECScoring, idx = new Map(PLAYERS.players.map(p => [p.id, p]));
  const { a, tok, ids } = await liveLeague(['Ann', 'Ben']);
  await draftAll(a);
  await call('POST', '/api/admin/op', { token: a, body: { op: 'setFaab', budget: 100 } });
  await call('POST', '/api/admin/op', { token: a, body: { op: 'setTradeRules', rules: { freeAgents: true, perWeek: 0, mode: 'always', rosterRules: true, teamLimit: false,
    faMode: 'waiver', waiver: { days: [1, 2, 3, 4, 5, 6, 7], time: '03:00', order: 'faab' } } } });
  const L = league(), ros = S.rosters(L), own = S.ownership(L);
  const X = PLAYERS.players.find(p => !own.has(p.id) && ['Ann', 'Ben'].every(n => ros[ids[n]].some(q => idx.get(q).role === p.role)));
  const out = n => ros[ids[n]].find(q => idx.get(q).role === X.role);
  let r = await call('POST', '/api/trade', { token: tok.Ann, body: { action: 'claim', out: out('Ann'), in: X.id, bid: 150 } });
  assert(r.status === 400 && /zu hoch/.test(r.body.error), 'bid above budget refused');
  await call('POST', '/api/trade', { token: tok.Ann, body: { action: 'claim', out: out('Ann'), in: X.id, bid: 30 } });
  await call('POST', '/api/trade', { token: tok.Ben, body: { action: 'claim', out: out('Ben'), in: X.id, bid: 50 } });
  r = await call('POST', '/api/admin/op', { token: a, body: { op: 'runWaivers' } });
  assert(r.status === 200 && /1 Wechsel/.test(r.body.message), 'run: ' + JSON.stringify(r.body));
  assert(S.ownership(league()).get(X.id) === ids.Ben, 'higher bid wins');
  assert(S.faabLeft(league(), ids.Ben) === 50 && S.faabLeft(league(), ids.Ann) === 100, 'only the winner pays');
  return 'bid above budget refused, highest bid wins, only the winner pays';
};

tests.github_hiccups_are_safe = async () => {
  const { a, tok } = await liveLeague(['Ann', 'Ben']);
  await call('POST', '/api/pick', { token: tok.Ann, body: { player: 'G2_TOP' } });
  await call('POST', '/api/pick', { token: tok.Ben, body: { player: 'FNC_TOP' } });
  const orig = gh.handle;
  // 1) the write LANDS but GitHub answers 502 -> undo must remove ONE pick, not two
  let armed = true;
  gh.handle = async (url, init) => {
    const res = await orig(url, init);
    if (armed && init && init.method === 'PUT') { armed = false; return new Response('bad gateway', { status: 502 }); }
    return res;
  };
  let r = await call('POST', '/api/admin/op', { token: a, body: { op: 'undoPick' } });
  assert(r.status === 200, 'undo reported success: ' + JSON.stringify(r.body));
  assert(league().draft.picks.length === 1, `exactly one pick undone, ${league().draft.picks.length} left`);
  // 2) the write does NOT land and GitHub answers 502 -> retried, applied once
  armed = true;
  gh.handle = async (url, init) => {
    if (armed && init && init.method === 'PUT') { armed = false; return new Response('bad gateway', { status: 502 }); }
    return orig(url, init);
  };
  r = await call('POST', '/api/pick', { token: tok.Ben, body: { player: 'FNC_MID' } });
  assert(r.status === 200 && league().draft.picks.length === 2, 'pick retried after a lost write');
  // 3) reads hiccup -> retried transparently
  let fails = 2;
  gh.handle = async (url, init) => {
    if (fails > 0 && (!init || !init.method) && url.includes('/contents/')) { fails--; return new Response('busy', { status: 503 }); }
    return orig(url, init);
  };
  r = await call('GET', '/api/state', { token: tok.Ann });
  gh.handle = orig;
  assert(r.status === 200, 'state survives two 503s in a row');
  return '502-after-landing does not double-apply; 502-before-landing retries; 503 reads retried';
};

tests.health_and_tools = async () => {
  const a = await admin();
  const h = (await call('GET', '/api/admin/health', { token: a })).body.checks;
  const bad = h.filter(c => c.ok === false && c.name !== 'Push');
  assert(!bad.length, 'health problems: ' + JSON.stringify(bad));
  assert((await call('POST', '/api/admin/stats', { token: a, body: {} })).status === 200 && gh.stats.dispatched === 1, 'stats dispatch');
  const r = await call('POST', '/api/admin/op', { token: a, body: { op: 'override', entry: { op: 'exclude', game: 'g1' } } });
  assert(r.status === 200 && gh.current('data/overrides.json').rows.length === 1, 'stat correction written to the site repo');
  const st = (await call('GET', '/api/admin/state', { token: a })).body;
  assert(st.privateData === true && st.dataRepo === 'me/site-data', 'reports private data repo');
  return `${h.length} health checks green, stats dispatch, stat corrections, private-repo mode`;
};

tests.no_secret_ever_leaks = async () => {
  const joined = bodies.join('\n');
  assert(!joined.includes(SECRET_TOKEN), 'GitHub token leaked');
  assert(!joined.includes(ADMIN_PW), 'admin password leaked');
  for (const pw of ['secret-Ann', 'secret-Fabi', 'brand-new-pw']) assert(!joined.includes(pw), 'member password leaked: ' + pw);
  return `${bodies.length} responses checked: no token, no admin or member password`;
};

// ── runner ─────────────────────────────────────────────────────────────────
function assert(c, m) { if (!c) throw new Error(m); }
let failed = 0;
const names = Object.keys(tests);
for (const name of names) {
  await setup();
  try { console.log(`  ok  ${name}: ${await tests[name]()}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
}
globalThis.fetch = realFetch;
console.log(`\n${names.length - failed}/${names.length} passed`);
process.exit(failed ? 1 : 0);
