"""
fetch_events.py - the international events (First Stand, MSI, Worlds) of the
season year, for the special-event fantasy. Writes per event

    data/events/<slug>.json  - teams with rosters, schedule, stages (Swiss
                               table, bracket), one stats row per player/game
    data/events/index.json   - which events exist, with dates and logo

Teams: those in the event schedule, plus the codes listed in data/config.json
"eventTeams" (announced participants Riot has not scheduled yet).
Rosters come from getTeams, which lists every team of every league - several
share a name or code (T1 / T1 Rookies, HLE / HLE Challengers), so the active
main-league team wins. Players that show up in games but not in a roster
(substitutes) are added from the stats.

Incremental like fetch_lolesports.py: games already in the event file are
not downloaded again.

    python scripts/fetch_events.py                  # season from data/config.json
    python scripts/fetch_events.py --season 2026 --only msi_2026
"""
import argparse, datetime, json, os, re, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_lolesports as F   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "events")
EVENT_LEAGUES = ("first_stand", "msi", "worlds")
SOON_DAYS = 45          # fetch an event this long before it starts


def event_tournaments(year):
    leagues = {l["slug"]: l for l in F.gw("getLeagues")["leagues"]}
    out = []
    for slug in EVENT_LEAGUES:
        lg = leagues.get(slug)
        if not lg:
            continue
        for t in F.gw("getTournamentsForLeague", leagueId=lg["id"])["leagues"][0]["tournaments"]:
            if t["slug"].endswith("_" + str(year)):
                out.append((lg, t))
    return sorted(out, key=lambda x: x[1]["startDate"])


def pick_team(cands):
    """Several getTeams entries share a name: prefer the active main-league one."""
    def score(t):
        hl = (t.get("homeLeague") or {}).get("name") or ""
        side = any(x in hl or x in t.get("name", "") for x in ("Challengers", "Academy", "Rookies", "Youth"))
        return (t.get("status") == "active", not side, bool(hl), len(t.get("players") or []))
    return max(cands, key=score) if cands else None


_LEAGUES, _SCHED = None, {}
def starting_five(team):
    """[(player id, IGN, role)] of the team's five in its latest home-league
    game. getTeams lists whole organisations (T1: 14 players incl. trainees),
    so the event roster is cut to who actually played last. None if unknown."""
    global _LEAGUES
    try:
        if _LEAGUES is None:
            _LEAGUES = {l["name"]: l["id"] for l in F.gw("getLeagues")["leagues"]}
        lid = _LEAGUES.get((team.get("homeLeague") or {}).get("name"))
        if not lid:
            return None
        if lid not in _SCHED:
            s = F.gw("getSchedule", leagueId=lid)["schedule"]
            evs = list(s["events"])
            tok = (s.get("pages") or {}).get("older")
            for _ in range(3):
                if not tok:
                    break
                s = F.gw("getSchedule", leagueId=lid, pageToken=tok)["schedule"]
                evs = s["events"] + evs
                tok = (s.get("pages") or {}).get("older")
            _SCHED[lid] = sorted((e for e in evs if e.get("state") == "completed" and e.get("type") == "match"), key=lambda e: e["startTime"])
        for e in reversed(_SCHED[lid]):
            if team["code"] not in [t.get("code") for t in e["match"]["teams"]]:
                continue
            det = F.gw("getEventDetails", id=e["match"]["id"])["event"]["match"]
            games = [g for g in det.get("games") or [] if g.get("state") == "completed"]
            if not games:
                continue
            w = F._get(F.FEED + f"window/{games[-1]['id']}")
            meta = (w or {}).get("gameMetadata")
            if not meta:
                return None
            for side in ("blueTeamMetadata", "redTeamMetadata"):
                if meta[side]["esportsTeamId"] == team["id"]:
                    return [(x["esportsPlayerId"], x.get("summonerName", ""), F.ROLE_MAP.get((x.get("role") or "").lower(), ""))
                            for x in meta[side]["participantMetadata"]]
            return None
    except Exception as e:   # noqa: BLE001 - without a five the full roster stays
        print(f"  ! five of {team.get('code')}: {e}", file=sys.stderr)
    return None


def rosters(sched, all_teams, extra=()):
    by_name, by_code = {}, {}
    for t in all_teams:
        by_name.setdefault(t["name"].lower(), []).append(t)
        by_code.setdefault(t["code"], []).append(t)
    want = {}
    for e in sched:
        for t in e["teams"]:
            if t["code"] and t["code"] != "TBD":
                want[t["code"]] = t.get("name") or ""
    # participants announced before Riot puts them into the schedule
    # (data/config.json "eventTeams": {"worlds_2026": ["T1", ...]})
    for code in extra:
        want.setdefault(code, "")
    teams, players = [], []
    for code, name in sorted(want.items()):
        t = (pick_team(by_name.get(name.lower(), [])) if name else None) or pick_team(by_code.get(code, []))
        if not t:
            print(f"  ! no roster for {code} {name}", file=sys.stderr)
            continue
        hl = t.get("homeLeague") or {}
        teams.append({"code": code, "name": t["name"], "id": t["id"], "logo": F.https(t.get("image")),
                      "league": hl.get("name") or "", "region": hl.get("region") or ""})
        roster = {p["id"]: p for p in t.get("players") or []}
        five = starting_five(t)
        if five:
            for pid, ign, role in five:
                p = roster.get(pid) or {}
                real = " ".join(x for x in (p.get("firstName"), p.get("lastName")) if x).strip()
                players.append({"id": pid, "name": p.get("summonerName") or ign, "realName": real,
                                "role": role or F.ROLE_MAP.get((p.get("role") or "").lower()) or "MID",
                                "team": code, "photo": F.https(p.get("image"))})
            continue
        for p in roster.values():
            role = F.ROLE_MAP.get((p.get("role") or "").lower())
            if not role:
                continue   # coaches / staff come through as role "none"
            real = " ".join(x for x in (p.get("firstName"), p.get("lastName")) if x).strip()
            players.append({"id": p["id"], "name": p["summonerName"], "realName": real, "role": role,
                            "team": code, "photo": F.https(p.get("image"))})
    return teams, players


def schedule_of(lg, t):
    """Every match of the event, with team names (for roster matching)."""
    rows = F.fetch_schedule(lg["id"], t)
    end = t["endDate"]
    rows = [r for r in rows if r["start"][:10] <= end]
    # fetch_schedule keeps only codes - add names from the raw schedule once
    return rows


def team_names(lg, t):
    names = {}
    s = F.gw("getSchedule", leagueId=lg["id"])["schedule"]
    pages = [s]
    tok = (s.get("pages") or {}).get("older")
    while tok and pages[-1]["events"] and pages[-1]["events"][0]["startTime"][:10] >= t["startDate"]:
        s2 = F.gw("getSchedule", leagueId=lg["id"], pageToken=tok)["schedule"]; pages.append(s2)
        tok = (s2.get("pages") or {}).get("older")
    tok = (pages[0].get("pages") or {}).get("newer")
    while tok:
        s2 = F.gw("getSchedule", leagueId=lg["id"], pageToken=tok)["schedule"]; pages.append(s2)
        tok = (s2.get("pages") or {}).get("newer")
    for p in pages:
        for e in p["events"]:
            for tm in (e.get("match") or {}).get("teams") or []:
                if tm.get("code") and tm["code"] != "TBD":
                    names[tm["code"]] = tm.get("name") or ""
    return names


LP = "https://lol.fandom.com/api.php"


def lp_bans(t, games, names, old):
    """Bans per game from Leaguepedia - the lolesports feed has no draft. One
    query for the whole event (Leaguepedia rate-limits hard); a game is matched
    by its ten champions, so no team-name mapping is needed. Games already
    known keep their bans; on any error the old ones stay."""
    norm = lambda x: re.sub(r"[^a-z0-9]", "", (x or "").lower())
    inv = {}
    for cid, n in names.items():
        inv[norm(n)] = cid
        inv[norm(cid)] = cid
    by_game = {}
    for r in games:
        if r.get("champ"):
            by_game.setdefault(r["game"], {}).setdefault(r["team"], set()).add(r["champ"])
    out = dict(old or {})
    todo = {g: v for g, v in by_game.items() if g not in out and len(v) == 2}
    if not todo:
        return out
    start = (datetime.date.fromisoformat(t["startDate"]) - datetime.timedelta(days=1)).isoformat()
    end = (datetime.date.fromisoformat(t["endDate"]) + datetime.timedelta(days=2)).isoformat()
    rows, off = [], 0
    try:
        while True:
            q = urllib.parse.urlencode({"action": "cargoquery", "format": "json", "tables": "ScoreboardGames", "limit": 500, "offset": off,
                                        "fields": "Team1Bans,Team2Bans,Team1Picks,Team2Picks,DateTime_UTC",
                                        "where": f'DateTime_UTC >= "{start} 00:00:00" AND DateTime_UTC <= "{end} 00:00:00"'})
            req = urllib.request.Request(LP + "?" + q, headers={"User-Agent": "lecfantasy-stats/1.0 (github.com/FNE-stack/lecfantasy)"})
            for attempt in range(2):
                j = json.load(urllib.request.urlopen(req, timeout=30))
                if (j.get("error") or {}).get("code") == "ratelimited":
                    time.sleep(30 * (attempt + 1))
                    continue
                break
            if j.get("error"):
                print(f"  ! leaguepedia: {j['error'].get('code')} - bans later", file=sys.stderr)
                return out
            page = [x["title"] for x in j.get("cargoquery", [])]
            rows += page
            if len(page) < 500:
                break
            off += 500
    except Exception as e:  # never let the bans break the stats
        print(f"  ! leaguepedia: {e} - bans later", file=sys.stderr)
        return out
    ids = lambda x: [inv[norm(c)] for c in (x or "").split(",") if norm(c) in inv]
    for gid, teams in todo.items():
        (a, ca), (b, cb) = teams.items()
        for r in rows:
            p1, p2 = set(ids(r.get("Team1Picks"))), set(ids(r.get("Team2Picks")))
            if len(p1 & ca) >= 4 and len(p2 & cb) >= 4:
                out[gid] = {a: ids(r.get("Team1Bans")), b: ids(r.get("Team2Bans"))}
                break
            if len(p1 & cb) >= 4 and len(p2 & ca) >= 4:
                out[gid] = {a: ids(r.get("Team2Bans")), b: ids(r.get("Team1Bans"))}
                break
    print(f"  bans: {len(out)} games ({len(out) - len(old or {})} new, {len(by_game) - len(out)} not on Leaguepedia yet)")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default=None)
    ap.add_argument("--only", default=None, help="one event slug")
    a = ap.parse_args()
    cfg = F.load_json(os.path.join(ROOT, "data", "config.json"), {})
    year = int(a.season or cfg.get("season") or datetime.date.today().year)
    os.makedirs(OUT, exist_ok=True)
    today = datetime.date.today()
    all_teams = None
    index = F.load_json(os.path.join(OUT, "index.json"), {"events": []})
    known_idx = {e["slug"]: e for e in index.get("events", [])}
    for lg, t in event_tournaments(year):
        slug = t["slug"]
        if a.only and slug != a.only:
            continue
        start = datetime.date.fromisoformat(t["startDate"])
        if (start - today).days > SOON_DAYS:
            print(f"{slug}: starts {t['startDate']} - later")
            known_idx[slug] = {"slug": slug, "league": lg["slug"], "name": lg["name"], "start": t["startDate"], "end": t["endDate"],
                               "logo": F.https(lg.get("image")), "ready": False}
            continue
        print(f"{slug}: {t['startDate']} .. {t['endDate']}")
        path = os.path.join(OUT, slug + ".json")
        old = F.load_json(path, {})
        known = {}
        for r in old.get("games", []):
            known.setdefault(r["game"], []).append(r)
        sched = schedule_of(lg, t)
        names = team_names(lg, t)
        for e in sched:
            for tm in e["teams"]:
                tm["name"] = names.get(tm["code"], "")
        if all_teams is None:
            all_teams = F.gw("getTeams")["teams"]
        teams, players = rosters(sched, all_teams, (cfg.get("eventTeams") or {}).get(slug, []))
        games, fresh, skipped = F.fetch_games(t["id"], known, slug) if any(e["state"] == "completed" for e in sched) else ([], 0, 0)
        # substitutes who played but are not on a roster
        ids = {p["id"] for p in players}
        for g in games:
            if g["player"] and g["player"] not in ids:
                ids.add(g["player"])
                players.append({"id": g["player"], "name": g["ign"], "realName": "", "role": g["role"] or "MID", "team": g["team"], "photo": ""})
        champs = F.load_json(os.path.join(ROOT, "data", "champions.json"), {}).get("names") or {}
        bans = lp_bans(t, games, champs, old.get("bans")) if games else (old.get("bans") or {})
        standings = F.fetch_standings(t) or {"stages": []}
        # stage of every match (for per-stage lineups and locks)
        stage_of = {}
        for i, st in enumerate(standings["stages"]):
            for sec in st["sections"]:
                for m in sec["matches"]:
                    stage_of[m["id"]] = i
        for e in sched:
            e["stage"] = stage_of.get(e["match"], None)
        for e in sched:
            for tm in e["teams"]:
                tm.pop("name", None)
        out = {"slug": slug, "league": lg["slug"], "name": lg["name"], "year": year, "start": t["startDate"], "end": t["endDate"],
               "logo": F.https(lg.get("image")), "updated": int(datetime.datetime.now().timestamp()),
               "stages": [{"name": s["name"], "sections": s["sections"]} for s in standings["stages"]],
               "teams": teams, "players": sorted(players, key=lambda p: (p["team"], "TJMBS".index(p["role"][0]), p["name"])),
               "schedule": sched, "games": games, "bans": bans}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        done = sum(1 for e in sched if e["state"] == "completed")
        print(f"  {len(teams)} teams, {len(players)} players, {done}/{len(sched)} matches done, {fresh} new games ({skipped} cached)")
        known_idx[slug] = {"slug": slug, "league": lg["slug"], "name": lg["name"], "start": t["startDate"], "end": t["endDate"],
                           "logo": out["logo"], "ready": bool(teams), "teams": len(teams), "done": bool(sched) and done == len(sched)}
    index = {"season": year, "events": sorted(known_idx.values(), key=lambda e: e["start"])}
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
