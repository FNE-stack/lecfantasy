#!/usr/bin/env python3
"""
fetch_lolesports.py - pulls teams, rosters and per-game player stats for one
LEC tournament from the lolesports API and writes:

    data/teams.json    - code, name, logo for every team in the tournament
    data/players.json  - the draft pool: id, IGN, real name, role, team, photo
    data/stats.json    - one row per player per game (k/d/a/cs/win/champ)

Why lolesports and not Leaguepedia: this is the API lolesports.com itself runs
on, it answers WITHOUT a login (Leaguepedia refuses anonymous cargoquery), it
has official logos and player photos, and every game names its players by
`esportsPlayerId` - the same id the rosters use. So stats join to players by
id, never by fuzzy name matching.

Two things it does not have, handled explicitly:
  * No per-game winner field. Each match carries its series score though, so
    Bo1 winners are exact, and for Bo3/Bo5 games are ranked by tower
    differential and exactly `gameWins` of them go to each team - the totals
    always match the official series result.
  * No multikills, so pentakills are not scored.

Incremental: games already in data/stats.json are not fetched again, so the
twice-daily Action only downloads games played since the last run.

    python scripts/fetch_lolesports.py                 # tournament from league.json
    python scripts/fetch_lolesports.py --tournament lec_split_3_2026
    python scripts/fetch_lolesports.py --dry-run
"""
import argparse, datetime, json, os, sys, time, urllib.error, urllib.parse, urllib.request

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# Public key shipped in the lolesports.com front-end; every community tool that
# reads this API uses it. It identifies the site, not a user - nothing secret.
API_KEY = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z"
GW = "https://esports-api.lolesports.com/persisted/gw/"
FEED = "https://feed.lolesports.com/livestats/v1/"
UA = "LEC-Fantasy-Group-Tool/2.0 (private league; github.com/FNE-stack/lecfantasy)"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MISSING = []   # games the live feed has no data for (filled by fetch_games)
ROLE_MAP = {"top": "TOP", "jungle": "JNG", "mid": "MID", "bottom": "BOT", "support": "SUP"}


def _get(url, headers=None, retries=4):
    delay = 3
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                body = r.read().decode("utf-8")
                return json.loads(body) if body.strip() else None
        except urllib.error.HTTPError as e:
            if e.code in (404, 204):
                return None
            if attempt == retries - 1:
                raise
        except Exception:
            if attempt == retries - 1:
                raise
        time.sleep(delay)
        delay *= 2


def gw(op, **params):
    params.setdefault("hl", "en-US")
    j = _get(GW + op + "?" + urllib.parse.urlencode(params), {"x-api-key": API_KEY})
    if not j or "data" not in j:
        raise SystemExit(f"lolesports {op} returned nothing - API changed or down?")
    return j["data"]


def https(url):
    # The API still hands out some http:// image URLs. GitHub Pages is https,
    # and browsers block or upgrade mixed content, so normalise here once.
    return ("https://" + url[len("http://"):]) if url and url.startswith("http://") else (url or "")


# ── tournament ─────────────────────────────────────────────────────────────
def resolve_tournament(want):
    leagues = gw("getLeagues")["leagues"]
    lec = next((l for l in leagues if l.get("slug") == "lec"), None)
    if not lec:
        raise SystemExit("LEC not found in getLeagues")
    tours = gw("getTournamentsForLeague", leagueId=lec["id"])["leagues"][0]["tournaments"]
    if want and want != "auto":
        t = next((t for t in tours if t["slug"] == want or t["id"] == want), None)
        if not t:
            raise SystemExit(f"tournament {want!r} not found. Known: "
                             + ", ".join(t["slug"] for t in tours[:8]))
        return lec, t
    # auto: the most recent tournament that has already started
    today = datetime.date.today().isoformat()
    started = [t for t in tours if t["startDate"] <= today]
    if not started:
        raise SystemExit("no LEC tournament has started yet")
    return lec, max(started, key=lambda t: t["startDate"])


def resolve_season(want):
    """(league, season tournaments ascending, current tournament).

    A season = every LEC tournament whose slug ends in _<year> (lec_split_1_2026,
    lec_winter_2025 ...). 'auto' = the year of the most recent tournament that
    has started. 'current' = the latest started one - its teams are the pool.
    """
    leagues = gw("getLeagues")["leagues"]
    lec = next((l for l in leagues if l.get("slug") == "lec"), None)
    if not lec:
        raise SystemExit("LEC not found in getLeagues")
    tours = gw("getTournamentsForLeague", leagueId=lec["id"])["leagues"][0]["tournaments"]
    today = datetime.date.today().isoformat()
    started = [t for t in tours if t["startDate"] <= today]
    if not started:
        raise SystemExit("no LEC tournament has started yet")
    year = str(want) if want and want != "auto" else max(started, key=lambda t: t["startDate"])["slug"].rsplit("_", 1)[-1]
    season = sorted([t for t in tours if t["slug"].endswith("_" + year)], key=lambda t: t["startDate"])
    if not season:
        raise SystemExit(f"no LEC tournaments for season {year}")
    begun = [t for t in season if t["startDate"] <= today]
    current = begun[-1] if begun else season[0]
    return lec, year, season, current


# ── teams + rosters ────────────────────────────────────────────────────────
def participants(tournament_id):
    """Team ids that actually play in this tournament, from its schedule.

    getTeams alone is no good: it lists every team that ever had LEC as home
    league (Gambit, Lemondogs, ROCCAT ...), many still flagged 'active'.
    """
    ids = {}
    for e in gw("getCompletedEvents", tournamentId=tournament_id)["schedule"]["events"]:
        for t in e["match"]["teams"]:
            if t.get("code") and t["code"] != "TBD":
                ids[t["name"]] = t["code"]
    return ids


def teams_and_players(part_names):
    all_teams = gw("getTeams")["teams"]
    teams, players = [], []
    for t in all_teams:
        if t["name"] not in part_names:
            continue
        # several historic orgs share a name across leagues; prefer the LEC one
        if (t.get("homeLeague") or {}).get("name") not in ("LEC", None):
            continue
        teams.append({
            "id": t["id"], "code": t["code"], "name": t["name"],
            "slug": t.get("slug", ""),
            "logo": https(t.get("image")),
            "logoAlt": https(t.get("alternativeImage")),
        })
        for p in t.get("players") or []:
            role = ROLE_MAP.get((p.get("role") or "").lower())
            if not role:
                continue   # coaches / staff come through as role "none"
            real = " ".join(x for x in (p.get("firstName"), p.get("lastName")) if x).strip()
            players.append({
                "id": p["id"], "name": p["summonerName"], "realName": real,
                "role": role, "team": t["code"], "photo": https(p.get("image")),
            })
    seen, uniq = set(), []
    for t in sorted(teams, key=lambda t: t["code"]):
        if t["code"] not in seen:
            seen.add(t["code"]); uniq.append(t)
    return uniq, sorted(players, key=lambda p: (p["team"], "TJMBS".index(p["role"][0]), p["name"]))


# ── games ──────────────────────────────────────────────────────────────────
def _round10(dt):
    dt = dt.replace(microsecond=0)
    return dt - datetime.timedelta(seconds=dt.second % 10)


def final_frame(game_id):
    """(metadata, last frame, game duration in seconds) of a finished game."""
    first = _get(FEED + f"window/{game_id}")
    if not first or not first.get("frames"):
        return None, None, 0
    meta = first["gameMetadata"]
    t0 = datetime.datetime.fromisoformat(first["frames"][0]["rfc460Timestamp"].replace("Z", "+00:00"))
    # Step forward past the end of the game. Normally the last frame says
    # gameState "finished". But for ~1 game in 10 (seen 2026-10-01 across the
    # Summer split - surrenders or a feed cut) it never does: the feed just
    # stops, and every later startingTime returns that same last frame. A
    # last frame that stops moving IS the end, so accept it.
    prev_ts = None
    for minutes in (70, 100, 140):
        at = _round10(t0 + datetime.timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
        w = _get(FEED + f"window/{game_id}?startingTime={at}")
        if not (w and w.get("frames")):
            continue
        last = w["frames"][-1]
        if last.get("gameState") == "finished" or last["rfc460Timestamp"] == prev_ts:
            t1 = datetime.datetime.fromisoformat(last["rfc460Timestamp"].replace("Z", "+00:00"))
            return meta, last, int((t1 - t0).total_seconds())
        prev_ts = last["rfc460Timestamp"]
    return meta, None, 0


def series_games(event):
    """[(game_id, number)] for completed games of one match."""
    out = []
    for g in event.get("games") or []:
        if g.get("state") == "completed":
            out.append((g["id"], g.get("number", 0)))
    return out


def fetch_games(tournament_id, known_games, slug):
    events = gw("getCompletedEvents", tournamentId=tournament_id)["schedule"]["events"]
    rows, fresh, skipped = [], 0, 0
    for e in events:
        m = e["match"]
        teams = m["teams"]
        if len(teams) != 2:
            continue
        team_by_id = {}
        wins_needed = {}
        detail = gw("getEventDetails", id=m["id"])["event"]["match"]
        for t in detail["teams"]:
            team_by_id[t["id"]] = t["code"]
            wins_needed[t["code"]] = (t.get("result") or {}).get("gameWins", 0)

        games = []
        for g in detail.get("games") or []:
            if g.get("state") != "completed":
                continue
            gid = g["id"]
            if gid in known_games:
                rows.extend(known_games[gid]); skipped += 1
                continue
            meta, last, dur = final_frame(gid)
            if not last:
                print(f"  ! {gid}: no finished frame, skipping for now", file=sys.stderr)
                continue
            # a feed that died at the start (seen once in 2026: 88 s, 0 kills,
            # 0 CS, 0 gold) is not a game result - counting it would give ten
            # players a 0/0/0 game. Skip it and report it for the admin.
            if all(p["creepScore"] == 0 and p["kills"] == 0 for side in ("blueTeam", "redTeam") for p in last[side]["participants"]):
                print(f"  ! {gid}: feed has no data (0 CS, 0 kills) - not counted", file=sys.stderr)
                MISSING.append({"game": gid, "match": m["id"], "tournament": slug, "ts": e["startTime"], "n": g.get("number", 0),
                                "teams": [t["code"] for t in teams]})
                continue
            fresh += 1
            games.append((gid, g.get("number", 0), e["startTime"], meta, last, team_by_id, dur))

        if not games:
            continue
        # decide winners: rank by tower margin, give each team its official
        # number of game wins (see module docstring)
        codes = list(wins_needed)
        a = codes[0]
        def margin(item):
            _, _, _, meta, last, tb, _dur = item
            side_of = {tb.get(meta["blueTeamMetadata"]["esportsTeamId"]): "blueTeam",
                       tb.get(meta["redTeamMetadata"]["esportsTeamId"]): "redTeam"}
            inv = {v: k for k, v in side_of.items()}
            sa = inv.get(a, "blueTeam")
            sb = "redTeam" if sa == "blueTeam" else "blueTeam"
            ta, tb_ = last[sa], last[sb]
            return (ta["towers"] - tb_["towers"], ta["inhibitors"] - tb_["inhibitors"],
                    ta["totalGold"] - tb_["totalGold"])
        # games already cached keep their stored winners; only new ones are
        # assigned, against the wins not yet accounted for
        cached_wins = {c: 0 for c in codes}
        for gid, _ in series_games(detail):
            seen_team = {}
            for r in known_games.get(gid, []):
                seen_team[r["team"]] = r["win"]
            for c, w in seen_team.items():
                if w:
                    cached_wins[c] = cached_wins.get(c, 0) + 1
        need_a = max(0, wins_needed.get(a, 0) - cached_wins.get(a, 0))
        ranked = sorted(games, key=margin, reverse=True)
        winners = {item[0]: (a if i < need_a else next(c for c in codes if c != a))
                   for i, item in enumerate(ranked)}

        for gid, num, start, meta, last, tb, dur in games:
            for side, mkey in (("blueTeam", "blueTeamMetadata"), ("redTeam", "redTeamMetadata")):
                code = tb.get(meta[mkey]["esportsTeamId"], "?")
                pmeta = {p["participantId"]: p for p in meta[mkey]["participantMetadata"]}
                for p in last[side]["participants"]:
                    pm = pmeta.get(p["participantId"], {})
                    rows.append({
                        "game": gid, "match": m["id"], "n": num, "ts": start,
                        "player": pm.get("esportsPlayerId", ""),
                        "ign": pm.get("summonerName", ""),
                        "team": code,
                        "champ": pm.get("championId", ""),
                        "role": ROLE_MAP.get((pm.get("role") or "").lower(), ""),
                        "k": p["kills"], "d": p["deaths"], "a": p["assists"],
                        "cs": p["creepScore"],
                        "win": winners[gid] == code,
                        "tournament": slug, "dur": dur,
                    })
        print(f"  {e['startTime'][:10]} {' vs '.join(t['code'] for t in teams):12} "
              f"{len(games)} new game(s)")
    return rows, fresh, skipped


# ── schedule ───────────────────────────────────────────────────────────────
def fetch_schedule(league_id, tour):
    """Every LEC match from the tournament start onwards, past and upcoming.

    Feeds "next game" on the manager pages and the "Week N" grouping of
    points. getSchedule pages outward from now: 'older' pages go back until we
    pass the tournament start, 'newer' pages hold everything not yet played.
    """
    def page(token=None):
        p = {"leagueId": league_id}
        if token:
            p["pageToken"] = token
        return gw("getSchedule", **p)["schedule"]

    first = page()
    events = list(first["events"])
    tok = (first.get("pages") or {}).get("older")
    while tok and events and events[0]["startTime"][:10] >= tour["startDate"]:
        s = page(tok)
        events = s["events"] + events
        tok = (s.get("pages") or {}).get("older")
    tok = (first.get("pages") or {}).get("newer")
    while tok:
        s = page(tok)
        events += s["events"]
        tok = (s.get("pages") or {}).get("newer")

    out, seen = [], set()
    for e in events:
        if e.get("type") != "match" or e["startTime"][:10] < tour["startDate"]:
            continue
        m = e["match"]
        if m["id"] in seen:
            continue
        seen.add(m["id"])
        out.append({
            "match": m["id"], "start": e["startTime"], "state": e["state"],
            "block": e.get("blockName", ""),
            "bestOf": (m.get("strategy") or {}).get("count", 1),
            "teams": [{"code": t.get("code", "TBD"),
                       "wins": (t.get("result") or {}).get("gameWins"),
                       "outcome": (t.get("result") or {}).get("outcome")}
                      for t in m.get("teams", [])],
        })
    return sorted(out, key=lambda x: x["start"])


# ── official standings + brackets ─────────────────────────────────────────
def fetch_standings(t):
    """Regular-season table and playoff bracket of one tournament, as the
    official site shows them (tiebreaks included). Matches keep their
    previousMatchIds, so the page can lay out the bracket rounds."""
    try:
        st = gw("getStandings", tournamentId=t["id"])["standings"]
    except SystemExit:
        return None
    if not st:
        return None
    stages = []
    for stage in st[0].get("stages") or []:
        secs = []
        for sec in stage.get("sections") or []:
            secs.append({
                "name": sec.get("name", ""),
                "rankings": [{"ordinal": r["ordinal"], "teams": [{"code": x["code"], "w": (x.get("record") or {}).get("wins", 0),
                              "l": (x.get("record") or {}).get("losses", 0)} for x in r.get("teams") or []]} for r in sec.get("rankings") or []],
                "matches": [{"id": m["id"], "state": m.get("state"), "prev": m.get("previousMatchIds") or [],
                             "teams": [{"code": x.get("code", "TBD"), "outcome": (x.get("result") or {}).get("outcome"),
                                        "wins": (x.get("result") or {}).get("gameWins")} for x in m.get("teams") or []]}
                            for m in sec.get("matches") or []],
            })
        stages.append({"name": stage.get("name", ""), "sections": secs})
    return {"stages": stages}


# ── champions ──────────────────────────────────────────────────────────────
def fetch_champions():
    """Data Dragon version + display names, for champion icons on the pages.

    The feed's championId is Data Dragon's key ("MonkeyKing"); the page wants
    "Wukong" as a label and the version for the icon URL. Verified 2026-10-01:
    all 101 champions played in the Summer split match a Data Dragon key.
    Cosmetic, so a failure here keeps the previous file instead of failing.
    """
    try:
        ver = _get("https://ddragon.leagueoflegends.com/api/versions.json")[0]
        data = _get(f"https://ddragon.leagueoflegends.com/cdn/{ver}/data/en_US/champion.json")["data"]
        return {"version": ver, "names": {k: v["name"] for k, v in sorted(data.items())}}
    except Exception as e:
        print(f"  ! Data Dragon unavailable ({e}); keeping old champions.json", file=sys.stderr)
        return None


# ── main ───────────────────────────────────────────────────────────────────
def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", help="year like 2026, or 'auto' (default: data/config.json)")
    ap.add_argument("--tournament", help="legacy: a single slug; its year becomes the season")
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--full", action="store_true", help="ignore cache, refetch every game")
    a = ap.parse_args()

    config = load_json(os.path.join(ROOT, "data", "config.json"), {})
    want = a.season or (a.tournament.rsplit("_", 1)[-1] if a.tournament and a.tournament != "auto" else None) \
        or config.get("season") or "auto"
    lec, year, season, cur = resolve_season(want)
    today = datetime.date.today().isoformat()
    print(f"season {year}: " + ", ".join(t["slug"] for t in season) + f" · current: {cur['slug']}")

    # the pool = teams of the latest tournament that has completed matches
    pool_tour = cur
    part = participants(pool_tour["id"])
    if not part:
        for t in reversed([t for t in season if t["startDate"] <= today]):
            part = participants(t["id"])
            if part:
                pool_tour = t
                break
    print(f"  pool from {pool_tour['slug']}: {len(part)} teams: {', '.join(sorted(part.values()))}")
    teams, players = teams_and_players(set(part))
    print(f"  {len(teams)} teams resolved, {len(players)} players in pool")
    if not players:
        print("!! empty player pool - leaving existing data untouched", file=sys.stderr)
        return 1

    old = load_json(os.path.join(a.out, "stats.json"), {})
    known = {}
    if not a.full:
        for r in old.get("games", []):
            if "dur" in r and r.get("tournament"):      # rows from before seasons get refetched once
                known.setdefault(r["game"], []).append(r)
    print(f"fetching games ({len(known)} cached) ...")
    rows = []
    for t in season:
        if t["startDate"] > today:
            continue
        r, fresh, cached = fetch_games(t["id"], known, t["slug"])
        print(f"  {t['slug']}: {fresh} new, {cached} cached, {len(r)} rows")
        rows += r

    pool_ids = {p["id"] for p in players}
    former = {}
    for r in rows:
        if r["player"] and r["player"] not in pool_ids and r["player"] not in former:
            ign = r["ign"].split(" ", 1)[1] if " " in r["ign"] else r["ign"]
            former[r["player"]] = {"id": r["player"], "name": ign, "realName": "",
                                   "role": r["role"], "team": r["team"], "photo": "", "former": True}

    sched = fetch_schedule(lec["id"], season[0])
    # tag every match with its split (by date range)
    for e in sched:
        d = e["start"][:10]
        e["tournament"] = next((t["slug"] for t in season if t["startDate"] <= d <= t["endDate"]), None)
    upcoming = sum(1 for e in sched if e["state"] != "completed")
    print(f"  schedule: {len(sched)} matches, {upcoming} not yet played")

    tours_out = []
    for t in season:
        ev = [e for e in sched if e["tournament"] == t["slug"]]
        done = t["endDate"] < today and all(e["state"] == "completed" for e in ev)
        tours_out.append({"slug": t["slug"], "start": t["startDate"], "end": t["endDate"],
                          "firstMatch": ev[0]["start"] if ev else None, "lastMatch": ev[-1]["start"] if ev else None,
                          "matches": len(ev), "done": done})

    now = int(time.time())
    out = {
        "teams.json": {"tournament": cur["slug"], "season": year, "updated": now,
                       "league": {"name": lec["name"], "logo": https(lec.get("image"))}, "teams": teams},
        "players.json": {"tournament": pool_tour["slug"], "season": year, "updated": now,
                         "players": players, "former": list(former.values())},
        "stats.json": {"tournament": cur["slug"], "season": year, "tournaments": [t["slug"] for t in season],
                       "updated": now, "source": "lolesports", "games": rows, "missing": MISSING},
        "schedule.json": {"tournament": cur["slug"], "season": year, "updated": now, "events": sched},
        "season.json": {"season": year, "current": cur["slug"], "updated": now, "tournaments": tours_out},
    }
    out["standings.json"] = {"season": year, "updated": now, "tournaments": {}}
    for t in season:
        if t["startDate"] <= today:
            sd = fetch_standings(t)
            if sd:
                out["standings.json"]["tournaments"][t["slug"]] = sd
    print(f"  standings: {len(out['standings.json']['tournaments'])} splits")

    champs = fetch_champions()
    if champs:
        out["champions.json"] = {"updated": now, **champs}
        print(f"  Data Dragon {champs['version']}, {len(champs['names'])} champions")

    if a.dry_run:
        print(json.dumps(out["season.json"], indent=1, ensure_ascii=False))
        return 0
    os.makedirs(a.out, exist_ok=True)
    for fn, data in out.items():
        path = os.path.join(a.out, fn)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
            f.write("\n")
        print(f"wrote {fn} ({os.path.getsize(path) / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
