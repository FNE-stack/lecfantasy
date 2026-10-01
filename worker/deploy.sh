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

# 2. secrets (piped, so they never appear in argv or shell history)
for v in GITHUB_TOKEN ADMIN_PASSWORD VAPID_PUBLIC VAPID_PRIVATE; do
  if [ -n "${!v:-}" ]; then
    printf '%s' "${!v}" | npx wrangler secret put "$v" >/dev/null
    echo "$v secret set"
  else
    echo "($v not in $ENV_FILE - skipped)"
  fi
done

# 3. deploy
out=$(npx wrangler deploy 2>&1) || { echo "$out"; exit 1; }
url=$(printf '%s' "$out" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
[ -n "$url" ] || { echo "$out"; echo "deployed, but no workers.dev URL found - is a workers.dev subdomain set up?"; exit 1; }
echo "deployed: $url"

# 4. the site's Worker URL lives in app.js (WORKER constant)
grep -q "$url" ../app.js || echo "NOTE: app.js WORKER is not $url - update it and push"

# smoke test: without a login the league must be refused (401), never served
code=$(curl -s -o /dev/null -w '%{http_code}' "$url/api/state")
[ "$code" = "401" ] && echo "smoke test OK: $url/api/state refuses anonymous access (401)"   || { echo "smoke test FAILED: $url/api/state returned $code"; exit 1; }
