// ═══════════════════════════════════════════════════════════════════════════
// devserver.mjs — the whole thing, locally, with no Cloudflare and no GitHub.
//
// Serves the repo as static files AND runs the real worker/src/index.js behind
// /api/*, with KV and the GitHub contents API stubbed in memory (writes go to
// a scratch copy, your data/ files are never touched). Lets you click through
// a complete draft before anyone deploys anything.
//
//     node worker/devserver.mjs          then open http://localhost:8787/pick.html
//
// Resets to an empty draft every restart.
// ═══════════════════════════════════════════════════════════════════════════
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};

// ── stubs ──────────────────────────────────────────────────────────────────
const kv = new Map();
const KV = {
  async get(k, type) {
    const v = kv.has(k) ? kv.get(k) : null;
    return type === 'json' && v !== null ? JSON.parse(v) : v;
  },
  async put(k, v) { kv.set(k, v); },
};

const repoFiles = new Map();
let shaN = 0;
function seed(p) {
  const obj = JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
  if (p.endsWith('league.json')) { obj.draft.picks = []; obj.draft.completed = false; }
  repoFiles.set(p, { text: JSON.stringify(obj, null, 2) + '\n', sha: 'sha' + (++shaN) });
}
seed('data/league.json');
seed('data/players.json');

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.github.com/')) return realFetch(url, init);
  const p = decodeURIComponent(new URL(u).pathname.split('/contents/')[1]);
  const rec = repoFiles.get(p);
  if (!rec) return new Response('not found', { status: 404 });
  if (!init.method || init.method === 'GET') {
    const b64 = Buffer.from(rec.text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
    return new Response(JSON.stringify({ content: b64, sha: rec.sha }), { status: 200 });
  }
  if (init.method === 'PUT') {
    const body = JSON.parse(init.body);
    if (body.sha !== rec.sha) return new Response('{"message":"conflict"}', { status: 409 });
    rec.text = Buffer.from(body.content, 'base64').toString('utf8');
    rec.sha = 'sha' + (++shaN);
    console.log(`  [repo] ${p} <- ${body.message}`);
    return new Response(JSON.stringify({ content: { sha: rec.sha } }), { status: 200 });
  }
  return new Response('bad', { status: 400 });
};

const env = {
  LEAGUE: KV,
  GITHUB_REPO: 'local/dev',
  GITHUB_BRANCH: 'main',
  GITHUB_TOKEN: 'dev-token-never-leaves-this-process',
  ALLOWED_ORIGIN: '*',
};

const worker = (await import('./src/index.js')).default;

// ── server ─────────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const wreq = new Request('https://dev.local' + url.pathname + url.search, {
      method: req.method,
      headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const wres = await worker.fetch(wreq, env);
    res.writeHead(wres.status, Object.fromEntries(wres.headers));
    res.end(Buffer.from(await wres.arrayBuffer()));
    console.log(`  ${req.method} ${url.pathname} -> ${wres.status}`);
    return;
  }

  // serve the repo, but hand out the scratch copies so the page sees picks
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'pick.html';
  if (repoFiles.has(rel)) {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(repoFiles.get(rel).text);
    return;
  }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 ' + rel); return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(fs.readFileSync(file));
}).listen(PORT, () => {
  console.log(`dev server on http://localhost:${PORT}`);
  console.log(`  draft page   http://localhost:${PORT}/pick.html?worker=http://localhost:${PORT}`);
  console.log(`  league page  http://localhost:${PORT}/league.html`);
  console.log('  (in-memory: restart resets the draft; data/ on disk is untouched)');
});
