#!/usr/bin/env python3
"""
fetch_lec.py — pulls LEC rosters + per-game player stats from Leaguepedia's
Cargo API and writes data/players.json and data/stats.json.

Run by .github/workflows/update-stats.yml on a cron. It runs in GitHub Actions
rather than in the browser for three reasons:
  1. No CORS. The browser can't call lol.fandom.com directly.
  2. Rate limits. Leaguepedia rate-limits per IP and is aggressive about it
     (this script was written while the author's IP was limited out); an Actions
     runner gets a clean IP and we only call it a few times per day.
  3. One place to fix. If the Cargo schema changes, this file changes — the
     static page keeps reading the same JSON shape.

Usage:
    python fetch_lec.py --split "LEC/2026 Season/Summer Season"
    python fetch_lec.py --split ... --dry-run     # print, don't write

SCHEMA NOTE: field names below come from Leaguepedia's public Cargo table
definitions (Module:CargoDeclare/ScoreboardPlayers). --verify prints what the
API actually returned so a schema drift is obvious in the Action log.
"""
import argparse, http.cookiejar, json, os, sys, time
import urllib.error, urllib.parse, urllib.request

# Windows terminals default to cp1252, which cannot encode the box-drawing and
# check marks used in the output below — a local run would die inside print().
# Force UTF-8 on both streams; harmless on the Actions runner, which is already
# UTF-8. `errors="replace"` so an odd player name can never abort a fetch.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

API = "https://lol.fandom.com/api.php"
UA = "LEC-Fantasy-Group-Tool/1.0 (private league; contact via repo issues)"

# Anonymous cargoquery on Fandom is limited to roughly ONE request per minute,
# and caps pages at 500 rows. A free bot account (Special:BotPasswords on
# lol.fandom.com) lifts both: 5000-row pages and a usable request rate. For a
# full split of scoreboards (thousands of rows) anonymous access is impractical,
# so set these as repo secrets and the workflow passes them through:
#     LEAGUEPEDIA_USERNAME = "YourUser@YourBotName"
#     LEAGUEPEDIA_PASSWORD = "<bot password>"
# Without them the script still works, just slowly and with small pages.
USERNAME = os.environ.get("LEAGUEPEDIA_USERNAME", "").strip()
PASSWORD = os.environ.get("LEAGUEPEDIA_PASSWORD", "").strip()

_jar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_jar))
_authed = False
PAGE_ANON, PAGE_BOT = 500, 5000


def _post(params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(API, data=data, headers={"User-Agent": UA})
    with _opener.open(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8"))


def login():
    """Log in with a bot password. Returns True on success."""
    global _authed
    if not (USERNAME and PASSWORD):
        print("  (no LEAGUEPEDIA_USERNAME/PASSWORD — anonymous mode. "
              "Leaguepedia currently refuses anonymous cargoquery outright, so "
              "this will abort at the first query.)", file=sys.stderr)
        return False
    try:
        tok = _post({"action": "query", "meta": "tokens", "type": "login",
                     "format": "json"})
        lt = tok["query"]["tokens"]["logintoken"]
        res = _post({"action": "login", "lgname": USERNAME,
                     "lgpassword": PASSWORD, "lgtoken": lt, "format": "json"})
        ok = res.get("login", {}).get("result") == "Success"
        if ok:
            _authed = True
            print(f"  logged in as {USERNAME}")
        else:
            print(f"  ! login failed: {res.get('login', {}).get('result')} "
                  f"— falling back to anonymous", file=sys.stderr)
        return ok
    except Exception as e:
        print(f"  ! login error {e} — falling back to anonymous", file=sys.stderr)
        return False


def page_size():
    return PAGE_BOT if _authed else PAGE_ANON

# Leaguepedia role strings -> our slot names
ROLE_MAP = {
    "Top": "TOP", "Jungle": "JNG", "Mid": "MID", "Middle": "MID",
    "Bot": "BOT", "ADC": "BOT", "AD Carry": "BOT", "Support": "SUP",
}


def cargo(tables, fields, where="", limit=500, offset=0, join_on="", retries=4):
    """One Cargo query, with backoff on rate limiting."""
    params = {
        "action": "cargoquery", "format": "json",
        "tables": tables, "fields": fields,
        "limit": str(limit), "offset": str(offset),
    }
    if where:
        params["where"] = where
    if join_on:
        params["join_on"] = join_on
    url = API + "?" + urllib.parse.urlencode(params)
    # Anonymous callers get ~1 req/min, so back off much harder without auth.
    delay = 8 if _authed else 65
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with _opener.open(req, timeout=40) as r:
                payload = json.loads(r.read().decode("utf-8"))
        except Exception as e:
            print(f"  ! request failed ({e}); retry in {delay}s", file=sys.stderr)
            time.sleep(delay); delay *= 2
            continue
        if "error" in payload:
            code = payload["error"].get("code", "?")
            if code == "ratelimited" and not _authed:
                # Measured 2026-10-01 from a clean IP with no prior traffic:
                # the very first anonymous cargoquery already returns
                # 'ratelimited', while plain action=query returns 200. So this
                # is not a throttle we can wait out — anonymous Cargo access is
                # closed. Retrying just burns ~8 minutes and then reports the
                # wrong cause, so fail now and say what actually fixes it.
                raise SystemExit(
                    "Leaguepedia refuses anonymous cargoquery (error "
                    "'ratelimited' on the first request).\n"
                    "  Set LEAGUEPEDIA_USERNAME and LEAGUEPEDIA_PASSWORD "
                    "(lol.fandom.com -> Special:BotPasswords).\n"
                    "  In Actions these are repo secrets; locally, export them "
                    "before running this script.")
            print(f"  ! API error {code}; retry in {delay}s", file=sys.stderr)
            if code == "ratelimited":
                time.sleep(delay); delay *= 2
                continue
            raise SystemExit(f"Cargo error: {payload['error']}")
        return [row["title"] for row in payload.get("cargoquery", [])]
    raise SystemExit("Cargo API unreachable after retries")


def paged(tables, fields, where="", join_on="", page=None, cap=40000):
    page = page or page_size()
    out, off = [], 0
    while off < cap:
        rows = cargo(tables, fields, where, limit=page, offset=off, join_on=join_on)
        out.extend(rows)
        if len(rows) < page:
            break
        off += page
        # authenticated: brief courtesy pause. anonymous: the limit is ~1/min,
        # so pacing here avoids burning retries on guaranteed 'ratelimited'.
        time.sleep(2 if _authed else 62)
    return out


def fetch_rosters(split):
    """Current rosters for the split -> the draftable player pool."""
    rows = paged(
        "TournamentPlayers",
        "Player,Team,Role",
        where=f'TournamentPlayers.OverviewPage="{split}"',
    )
    players, seen = [], set()
    for r in rows:
        name = (r.get("Player") or "").strip()
        team = (r.get("Team") or "").strip()
        role = ROLE_MAP.get((r.get("Role") or "").strip(), None)
        if not name or not team or not role or name in seen:
            continue
        seen.add(name)
        players.append({"id": name, "name": name, "team": team, "role": role})
    return players


def fetch_stats(split):
    """Per-game player scoreboards for the split."""
    rows = paged(
        "ScoreboardPlayers",
        "Link,Team,Champion,Kills,Deaths,Assists,CS,DateTime_UTC,PlayerWin,"
        "Role,Pentakills",
        where=f'ScoreboardPlayers.OverviewPage="{split}"',
    )
    games = []
    for r in rows:
        name = (r.get("Link") or "").strip()
        if not name:
            continue
        def num(k):
            try:
                return float(r.get(k) or 0)
            except (TypeError, ValueError):
                return 0.0
        win = str(r.get("PlayerWin") or "").strip().lower()
        games.append({
            "player": name,
            "team": (r.get("Team") or "").strip(),
            "champ": (r.get("Champion") or "").strip(),
            "k": num("Kills"), "d": num("Deaths"), "a": num("Assists"),
            "cs": num("CS"),
            # Verified present in Module:CargoDeclare/ScoreboardPlayers.
            # Triple/quadra kills have no field there, so they are not scored.
            "penta": num("Pentakills"),
            "win": win in ("yes", "1", "true"),
            "ts": (r.get("DateTime UTC") or r.get("DateTime_UTC") or "").strip(),
        })
    return games


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True,
                    help='e.g. "LEC/2026 Season/Summer Season"')
    ap.add_argument("--out", default="data")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify", action="store_true",
                    help="print raw first rows so schema drift is visible")
    a = ap.parse_args()

    print(f"split: {a.split}")
    login()
    print(f"page size: {page_size()} rows ({'bot' if _authed else 'anonymous'})")
    print("fetching rosters …")
    players = fetch_rosters(a.split)
    print(f"  {len(players)} players")
    if a.verify and players:
        print("  sample:", json.dumps(players[0], ensure_ascii=False))

    print("fetching scoreboards …")
    games = fetch_stats(a.split)
    print(f"  {len(games)} player-games")
    if a.verify and games:
        print("  sample:", json.dumps(games[0], ensure_ascii=False))

    if not players:
        print("!! no players returned — schema may have changed, or the split "
              "name is wrong. Existing data left untouched.", file=sys.stderr)
        return 1

    payload_players = {"split": a.split, "updated": int(time.time()),
                       "players": players}
    payload_stats = {"split": a.split, "updated": int(time.time()),
                     "games": games}

    if a.dry_run:
        print(json.dumps(payload_players, indent=2, ensure_ascii=False)[:1200])
        return 0

    os.makedirs(a.out, exist_ok=True)
    for fn, data in (("players.json", payload_players), ("stats.json", payload_stats)):
        path = os.path.join(a.out, fn)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        print(f"wrote {path} ({os.path.getsize(path)/1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
