// ═══════════════════════════════════════════════════════════════════════════
// test_worker.mjs — exercises the draft referee end to end in plain node.
//
// No wrangler, no network, no Cloudflare account needed: KV and the GitHub
// contents API are stubbed in memory. The point is that the rules the Worker
// enforces (whose turn, legal pick, password, concurrency) are verified here
// BEFORE draft night, since that is the one evening where a bug is expensive.
//
//     node worker/test_worker.mjs
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

// ── in-memory KV ───────────────────────────────────────────────────────────
function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k, type) {
      const v = m.has(k) ? m.get(k) : null;
      return type === 'json' && v !== null ? JSON.parse(v) : v;
    },
    async put(k, v) { m.set(k, v); },
  };
}

// ── in-memory GitHub contents API ──────────────────────────────────────────
// Mirrors the parts the Worker uses: base64 content, a sha that changes on
// every write, and 409 when the client PUTs against a stale sha.
function makeGitHub(files) {
  const store = new Map();
  let counter = 0;
  const shaOf = () => 'sha' + (++counter);
  for (const [p, obj] of Object.entries(files)) {
    store.set(p, { text: JSON.stringify(obj, null, 2) + '\n', sha: shaOf() });
  }
  const stats = { puts: 0, conflicts: 0 };

  async function handler(url, init = {}) {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname.split('/contents/')[1]);
    const rec = store.get(p);
    if (!rec) return new Response('not found', { status: 404 });

    if (!init.method || init.method === 'GET') {
      const b64 = Buffer.from(rec.text, 'utf8').toString('base64');
      // GitHub wraps base64 at 60 chars; the Worker must cope with that.
      const wrapped = b64.replace(/(.{60})/g, '$1\n');
      return new Response(JSON.stringify({ content: wrapped, sha: rec.sha }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init.method === 'PUT') {
      stats.puts++;
      const body = JSON.parse(init.body);
      if (body.sha !== rec.sha) {
        stats.conflicts++;
        return new Response(JSON.stringify({ message: 'conflict' }), { status: 409 });
      }
      rec.text = Buffer.from(body.content, 'base64').toString('utf8');
      rec.sha = shaOf();
      return new Response(JSON.stringify({ content: { sha: rec.sha } }), { status: 200 });
    }
    return new Response('bad', { status: 400 });
  }
  return { handler, store, stats, current: p => JSON.parse(store.get(p).text) };
}

// ── fixtures ───────────────────────────────────────────────────────────────
const baseLeague = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data', 'league.json'), 'utf8'));

function freshLeague() {
  const l = JSON.parse(JSON.stringify(baseLeague));
  l.draft.picks = [];
  l.draft.completed = false;
  l.swaps = [];
  return l;
}

// Enough players that a full snake draft is actually completable:
// 6 teams x 5 roles, so role and maxPerTeam limits are reachable but not fatal.
function makePlayers() {
  const teams = ['G2', 'FNC', 'KC', 'MKOI', 'VIT', 'TH'];
  const roles = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
  const players = [];
  for (const t of teams) {
    for (const r of roles) players.push({ id: `${t}_${r}`, name: `${t}_${r}`, team: t, role: r });
  }
  return { split: 'test', updated: 0, players };
}

let worker, env, gh;

async function setup() {
  gh = makeGitHub({
    'data/league.json': freshLeague(),
    'data/players.json': makePlayers(),
  });
  globalThis.fetch = (url, init) => gh.handler(String(url), init);
  env = {
    LEAGUE: makeKV(),
    GITHUB_REPO: 'test/test',
    GITHUB_BRANCH: 'main',
    GITHUB_TOKEN: 'fake-token-never-leaves-here',
    ALLOWED_ORIGIN: '*',
  };
  if (!worker) worker = (await import('./src/index.js')).default;
}

const call = (method, pathname, { body, token } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return worker.fetch(new Request('https://w.dev' + pathname, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  }), env);
};
const asJson = async r => ({ status: r.status, body: await r.json() });

// ── tests ──────────────────────────────────────────────────────────────────
const tests = {};

tests.state_is_public = async () => {
  const { status, body } = await asJson(await call('GET', '/api/state'));
  assert(status === 200, 'state should be readable without a login');
  assert(body.onTheClock === 'm1', `m1 picks first, got ${body.onTheClock}`);
  assert(body.claimed.m1 === false, 'nothing claimed yet');
  assert(body.league.managers.length === 4, 'four managers');
  return 'readable without auth, m1 on the clock';
};

tests.claim_then_login = async () => {
  let r = await asJson(await call('POST', '/api/claim',
    { body: { manager: 'm1', displayName: 'Fabi', password: 'hunter22' } }));
  assert(r.status === 200 && r.body.token, 'claim should succeed');

  // same slot cannot be taken twice
  r = await asJson(await call('POST', '/api/claim',
    { body: { manager: 'm1', password: 'somethingelse' } }));
  assert(r.status === 409, `re-claim must be refused, got ${r.status}`);

  r = await asJson(await call('POST', '/api/login',
    { body: { manager: 'm1', password: 'wrong-one' } }));
  assert(r.status === 401, `wrong password must 401, got ${r.status}`);

  r = await asJson(await call('POST', '/api/login',
    { body: { manager: 'm1', password: 'hunter22' } }));
  assert(r.status === 200 && r.body.token, 'correct password should log in');

  // short passwords refused
  r = await asJson(await call('POST', '/api/claim',
    { body: { manager: 'm2', password: 'abc' } }));
  assert(r.status === 400, `short password must be refused, got ${r.status}`);
  return 'claim once, re-claim refused, wrong password refused, login works';
};

tests.pick_requires_login_and_turn = async () => {
  const m1 = (await (await call('POST', '/api/claim',
    { body: { manager: 'm1', password: 'hunter22' } })).json()).token;
  const m2 = (await (await call('POST', '/api/claim',
    { body: { manager: 'm2', password: 'hunter22' } })).json()).token;

  let r = await asJson(await call('POST', '/api/pick', { body: { player: 'G2_TOP' } }));
  assert(r.status === 401, `no token must 401, got ${r.status}`);

  r = await asJson(await call('POST', '/api/pick',
    { body: { player: 'G2_TOP' }, token: 'not-a-real-session' }));
  assert(r.status === 401, `bogus token must 401, got ${r.status}`);

  // boy2 is not on the clock
  r = await asJson(await call('POST', '/api/pick',
    { body: { player: 'G2_TOP' }, token: m2 }));
  assert(r.status === 409, `out-of-turn must 409, got ${r.status} ${r.body.error}`);

  r = await asJson(await call('POST', '/api/pick',
    { body: { player: 'G2_TOP' }, token: m1 }));
  assert(r.status === 200, `m1's turn should work, got ${r.body.error}`);
  assert(r.body.onTheClock === 'm2', 'clock should advance to m2');

  // the same player cannot go twice
  r = await asJson(await call('POST', '/api/pick',
    { body: { player: 'G2_TOP' }, token: m2 }));
  assert(r.status === 422, `duplicate player must 422, got ${r.status}`);

  const committed = gh.current('data/league.json');
  assert(committed.draft.picks.length === 1, 'exactly one pick committed');
  assert(committed.draft.picks[0].manager === 'm1', 'pick attributed to m1');
  return 'anonymous/bogus/out-of-turn/duplicate all refused, legal pick commits';
};

tests.team_limit_enforced = async () => {
  const tok = {};
  for (const m of ['m1', 'm2', 'm3', 'm4']) {
    tok[m] = (await (await call('POST', '/api/claim',
      { body: { manager: m, password: 'hunter22' } })).json()).token;
  }
  // maxPerTeam is 2, so fabi taking a third G2 player must be refused.
  const order = ['m1', 'm2', 'm3', 'm4', 'm4', 'm3', 'm2', 'm1'];
  const picks = ['G2_TOP', 'FNC_TOP', 'KC_TOP', 'MKOI_TOP',
                 'VIT_TOP', 'TH_TOP', 'FNC_JNG', 'G2_JNG'];
  for (let i = 0; i < order.length; i++) {
    const r = await asJson(await call('POST', '/api/pick',
      { body: { player: picks[i] }, token: tok[order[i]] }));
    assert(r.status === 200, `pick ${i} (${order[i]} -> ${picks[i]}) failed: ${r.body.error}`);
  }
  // round 3 starts with fabi again; he now has G2_TOP + G2_JNG
  const r = await asJson(await call('POST', '/api/pick',
    { body: { player: 'G2_MID' }, token: tok.m1 }));
  assert(r.status === 422, `third G2 player must be refused, got ${r.status}`);
  assert(/max\. 2 von G2/.test(r.body.error), `expected team-limit reason, got "${r.body.error}"`);
  return 'maxPerTeam blocked a third G2 pick with the right reason';
};

tests.full_draft_completes = async () => {
  const tok = {};
  for (const m of ['m1', 'm2', 'm3', 'm4']) {
    tok[m] = (await (await call('POST', '/api/claim',
      { body: { manager: m, password: 'hunter22' } })).json()).token;
  }
  const pool = makePlayers().players.map(p => p.id);
  let picked = 0, guard = 0;
  while (guard++ < 500) {
    const st = await (await call('GET', '/api/state')).json();
    const who = st.onTheClock;
    if (who === null) break;
    let took = false;
    for (const pid of pool) {
      const r = await call('POST', '/api/pick', { body: { player: pid }, token: tok[who] });
      if (r.status === 200) { picked++; took = true; break; }
    }
    assert(took, `${who} had no legal pick left after ${picked} picks`);
  }
  const league = gh.current('data/league.json');
  assert(picked === 24, `expected 24 picks, got ${picked}`);
  assert(league.draft.completed === true, 'draft should auto-lock when full');

  // and a pick after the lock is refused
  const r = await asJson(await call('POST', '/api/pick',
    { body: { player: pool[pool.length - 1] }, token: tok.m1 }));
  assert(r.status === 409, `pick after lock must 409, got ${r.status}`);

  // every manager ends with all five roles covered
  const byMgr = {};
  for (const p of league.draft.picks) (byMgr[p.manager] ||= []).push(p.player);
  for (const [m, ids] of Object.entries(byMgr)) {
    assert(ids.length === 6, `${m} should hold 6, holds ${ids.length}`);
    const roles = new Set(ids.map(i => i.split('_')[1]));
    for (const need of ['TOP', 'JNG', 'MID', 'BOT', 'SUP']) {
      assert(roles.has(need), `${m} is missing ${need}`);
    }
  }
  return '24 picks, auto-locked, all 5 roles per manager, locked draft rejects more';
};

tests.simultaneous_pick_has_one_winner = async () => {
  const m1 = (await (await call('POST', '/api/claim',
    { body: { manager: 'm1', password: 'hunter22' } })).json()).token;
  const m2 = (await (await call('POST', '/api/claim',
    { body: { manager: 'm2', password: 'hunter22' } })).json()).token;

  // Both fire at once while fabi is on the clock. boy2 must lose - and must
  // lose for the right reason, not by corrupting the file.
  const [a, b] = await Promise.all([
    call('POST', '/api/pick', { body: { player: 'G2_TOP' }, token: m1 }).then(asJson),
    call('POST', '/api/pick', { body: { player: 'FNC_MID' }, token: m2 }).then(asJson),
  ]);
  const oks = [a, b].filter(r => r.status === 200);
  assert(oks.length === 1, `exactly one should win, got ${oks.length}`);
  assert(oks[0].body.picked === 'G2_TOP', 'm1 was on the clock, so m1 wins');

  const league = gh.current('data/league.json');
  assert(league.draft.picks.length === 1, `file must hold 1 pick, holds ${league.draft.picks.length}`);
  return 'two simultaneous picks -> one commit, loser refused, file intact';
};

// The retry loop above is the thing most likely to bite on draft night, and
// the simultaneous-pick test does NOT reach it (the loser is refused on the
// turn check before it ever PUTs). So force a real 409: slip an unrelated
// write in between the Worker's read and its write, which is exactly what the
// host editing league.json mid-draft would do.
tests.recovers_from_a_lost_race = async () => {
  const m1 = (await (await call('POST', '/api/claim',
    { body: { manager: 'm1', password: 'hunter22' } })).json()).token;

  const realFetch = globalThis.fetch;
  let armed = true;
  globalThis.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    // after the Worker has read league.json once, bump it behind their back
    if (armed && String(url).includes('league.json') && (!init || !init.method || init.method === 'GET')) {
      armed = false;
      const rec = gh.store.get('data/league.json');
      const obj = JSON.parse(rec.text);
      obj.name = obj.name + ' (host edit)';
      rec.text = JSON.stringify(obj, null, 2) + '\n';
      rec.sha = 'sha-bumped-by-host';
    }
    return res;
  };

  const r = await asJson(await call('POST', '/api/pick',
    { body: { player: 'G2_TOP' }, token: m1 }));
  globalThis.fetch = realFetch;

  assert(gh.stats.conflicts >= 1, 'this test is pointless unless a 409 actually happened');
  assert(r.status === 200, `should recover and commit, got ${r.status} ${r.body.error}`);

  const league = gh.current('data/league.json');
  assert(league.draft.picks.length === 1, 'exactly one pick after recovery');
  assert(/host edit/.test(league.name), 'the competing edit must survive, not be clobbered');
  return `409 hit (${gh.stats.conflicts}x), retried, pick committed without losing the other edit`;
};

tests.token_never_reaches_the_page = async () => {
  const m1 = (await (await call('POST', '/api/claim',
    { body: { manager: 'm1', password: 'hunter22' } })).json()).token;
  const bodies = [];
  bodies.push(await (await call('GET', '/api/state')).text());
  bodies.push(await (await call('POST', '/api/login',
    { body: { manager: 'm1', password: 'hunter22' } })).text());
  bodies.push(await (await call('POST', '/api/pick',
    { body: { player: 'G2_TOP' }, token: m1 })).text());
  bodies.push(await (await call('POST', '/api/pick',
    { body: { player: 'nope' }, token: m1 })).text());
  for (const b of bodies) {
    assert(!b.includes(env.GITHUB_TOKEN), 'a response leaked the GitHub token');
    assert(!b.includes('hunter22'), 'a response echoed a password');
  }
  // and the stored credential is a hash, not the password
  const rec = JSON.parse(await env.LEAGUE.get('mgr:m1'));
  assert(!JSON.stringify(rec).includes('hunter22'), 'password stored in clear');
  assert(rec.hash && rec.salt && rec.hash.length === 64, 'expected a salted sha-256 hash');
  return 'no response leaks the token or a password; stored credential is salted+hashed';
};

// ── runner ─────────────────────────────────────────────────────────────────
function assert(cond, msg) { if (!cond) throw new Error(msg); }

let failed = 0;
const names = Object.keys(tests);
for (const name of names) {
  await setup();                       // fresh repo + KV per test
  try {
    const msg = await tests[name]();
    console.log(`  ok  ${name}: ${msg}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}
console.log(`\n${names.length - failed}/${names.length} passed`);
process.exit(failed ? 1 : 0);
