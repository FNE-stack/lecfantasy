#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# deploy.sh - puts the draft Worker online, idempotently.
#
#   bash worker/deploy.sh
#
# Reads credentials from ~/lecfantasy.env (outside the repo, never committed):
#   GITHUB_TOKEN=github_pat_...         fine-grained, Contents: read+write
#   CLOUDFLARE_API_TOKEN=...            template "Edit Cloudflare Workers"
#   CLOUDFLARE_ACCOUNT_ID=...
#
# 1. creates the KV namespace on first run and writes its id to wrangler.toml
# 2. stores GITHUB_TOKEN as a Worker secret (encrypted at Cloudflare)
# 3. deploys
# 4. writes the Worker URL into pick.html so the page knows where to talk
# Re-running is safe: an existing namespace and URL are left alone.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${LECFANTASY_ENV:-$HOME/lecfantasy.env}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE - see the header of this script"; exit 1; }
set -a; . "$ENV_FILE"; set +a
for v in GITHUB_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  [ -n "${!v:-}" ] || { echo "$v is empty in $ENV_FILE"; exit 1; }
done
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

[ -d node_modules ] || npm install --no-audit --no-fund

# 1. KV namespace
if grep -q 'PASTE_KV_ID_HERE' wrangler.toml; then
  echo "creating KV namespace LEAGUE ..."
  out=$(npx wrangler kv namespace create LEAGUE 2>&1) || { echo "$out"; exit 1; }
  id=$(printf '%s' "$out" | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$id" ] || { echo "could not read namespace id from:"; echo "$out"; exit 1; }
  sed -i "s/PASTE_KV_ID_HERE/$id/" wrangler.toml
  echo "  KV id $id written to wrangler.toml"
fi

# 2. secret (piped, so it never appears in argv or shell history)
printf '%s' "$GITHUB_TOKEN" | npx wrangler secret put GITHUB_TOKEN >/dev/null
echo "GITHUB_TOKEN secret set"

# 3. deploy
out=$(npx wrangler deploy 2>&1) || { echo "$out"; exit 1; }
url=$(printf '%s' "$out" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
[ -n "$url" ] || { echo "$out"; echo "deployed, but no workers.dev URL found - is a workers.dev subdomain set up?"; exit 1; }
echo "deployed: $url"

# 4. point the page at it
if grep -q "const DEFAULT_WORKER = 'PASTE_WORKER_URL_HERE';" ../pick.html; then
  sed -i "s#const DEFAULT_WORKER = 'PASTE_WORKER_URL_HERE';#const DEFAULT_WORKER = '$url';#" ../pick.html
  echo "pick.html now talks to $url (commit + push to publish)"
fi

# smoke test: the public endpoint must answer with league data
curl -sf "$url/api/state" | grep -q '"onTheClock"' && echo "smoke test OK: $url/api/state" \
  || { echo "smoke test FAILED: $url/api/state"; exit 1; }
