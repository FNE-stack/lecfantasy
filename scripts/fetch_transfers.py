#!/usr/bin/env python3
"""
fetch_transfers.py - LEC roster moves for the transfer ticker on the LEC tab.

Writes data/transfers.json: every join / leave / move of a player or staff
member at a current LEC team (data/teams.json) in the last DAYS days, newest
first, each with its source link.

Source: Leaguepedia's RosterChanges table (cargoquery, read-only, public). The
wiki records official announcements and the outlet that broke them; when that
outlet is Sheep Esports the item is flagged so the ticker can credit it.
Sheep Esports itself is not read: its site answers automated requests with a
bot challenge and opts out of automated use in robots.txt, so it only ever
appears as a link.

Never fails the workflow: on any error the old file stays as it is.

    python scripts/fetch_transfers.py
    python scripts/fetch_transfers.py --days 60 --dry-run
"""
import argparse, datetime, json, os, sys, time, urllib.error, urllib.parse, urllib.request

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

API = "https://lol.fandom.com/api.php"
UA = "LEC-Fantasy-Group-Tool/2.0 (private league; github.com/FNE-stack/lecfantasy)"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "transfers.json")

# lolesports name -> Leaguepedia name, where they differ.
ALIASES = {}

PLAYER_ROLES = {"Top": "Top", "Jungle": "Jungle", "Mid": "Mid", "Bot": "Bot", "Support": "Support"}


def cargo(params, retries=4):
    q = {"action": "cargoquery", "format": "json", "limit": "500", **params}
    url = API + "?" + urllib.parse.urlencode(q)
    delay = 5
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                j = json.loads(r.read().decode("utf-8"))
            if "error" in j:
                raise RuntimeError(j["error"].get("info", j["error"]))
            return [row["title"] for row in j.get("cargoquery", [])]
        except (urllib.error.URLError, RuntimeError, TimeoutError) as e:
            if attempt == retries - 1:
                raise
            print(f"  retry in {delay}s: {e}")
            time.sleep(delay)
            delay *= 2


def quote_list(names):
    return ",".join("'" + n.replace("'", "\\'") + "'" for n in names)


def parse_source(raw):
    """Leaguepedia packs sources as url;;;label;;;domain;;;lang;;;... separated by :::"""
    out = []
    for part in (raw or "").split(":::"):
        f = part.split(";;;")
        url = f[0].strip() if f else ""
        if not url.startswith("http"):
            continue
        label = f[1].strip() if len(f) > 1 else ""
        domain = f[2].strip() if len(f) > 2 else urllib.parse.urlparse(url).netloc
        out.append({"url": url, "label": label, "domain": domain,
                    "sheep": "sheepesports" in (url + domain).lower()})
    # a Sheep Esports report is credited first if there is one
    out.sort(key=lambda s: not s["sheep"])
    return out


def clean_player(name):
    # "FIESTA (An Hyeon-seo)" -> "FIESTA": the wiki disambiguates by real name
    return name.split(" (")[0].strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=120)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    teams = json.load(open(os.path.join(ROOT, "data", "teams.json"), encoding="utf-8"))["teams"]
    code_of = {}
    for t in teams:
        code_of[ALIASES.get(t["name"], t["name"])] = t["code"]
    since = (datetime.date.today() - datetime.timedelta(days=a.days)).isoformat()

    fields = "RC.Date_Sort=Date,RC.Player=Player,RC.Direction=Direction,RC.Team=Team,RC.Role=Role,RC.Status=Status,RC.Source=Source,RC.NewsId=NewsId"
    rows = cargo({
        "tables": "RosterChanges=RC", "fields": fields,
        "where": f"RC.Date_Sort >= '{since}' AND RC.Team IN ({quote_list(code_of)})",
        "order_by": "RC.Date_Sort DESC",
    })
    print(f"{len(rows)} roster changes at LEC teams since {since}")

    # Where did the leavers go / where did the joiners come from? One more
    # query for the same people at ANY team, so a move reads "A -> B".
    people = sorted({r["Player"] for r in rows})
    other = []
    for i in range(0, len(people), 40):
        other += cargo({
            "tables": "RosterChanges=RC", "fields": fields,
            "where": f"RC.Date_Sort >= '{since}' AND RC.Player IN ({quote_list(people[i:i + 40])})"
                     f" AND RC.Team NOT IN ({quote_list(code_of)})",
            "order_by": "RC.Date_Sort DESC",
        })

    def day(r):
        return (r.get("Date") or "")[:10]

    # A join and a leave at the SAME team for the same person on the same day
    # is a status change (role swap, contract, sub) - not a transfer.
    by = {}
    for r in rows:
        by.setdefault((day(r), r["Player"], r["Team"]), set()).add(r["Direction"])
    skip = {k for k, d in by.items() if {"Join", "Leave"} <= d}

    items, seen = [], set()
    for r in rows:
        key = (day(r), r["Player"], r["Team"])
        if key in skip or (key, r["Direction"]) in seen:
            continue
        seen.add((key, r["Direction"]))
        role = r.get("Role") or ""
        it = {
            "date": day(r),
            "player": clean_player(r["Player"]),
            "role": PLAYER_ROLES.get(role, role),
            "staff": role not in PLAYER_ROLES,
            "status": r.get("Status") or "",
            "kind": "join" if r["Direction"] == "Join" else "leave",
            "team": code_of.get(r["Team"]),
            "teamName": r["Team"],
            "src": parse_source(r.get("Source"))[:2],
        }
        # the other side of the move: the nearest change at a non-LEC team
        # within 45 days (a leave pairs with a later join, a join with an
        # earlier leave)
        want = "Join" if it["kind"] == "leave" else "Leave"
        d0 = datetime.date.fromisoformat(it["date"])
        best = None
        for o in other:
            if o["Player"] != r["Player"] or o["Direction"] != want or not day(o):
                continue
            gap = (datetime.date.fromisoformat(day(o)) - d0).days
            if it["kind"] == "join":
                gap = -gap
            if 0 <= gap <= 45 and (best is None or gap < best[0]):
                best = (gap, o)
        if best:
            if it["kind"] == "leave":
                it["to"] = best[1]["Team"]
            else:
                it["from"] = best[1]["Team"]
            if not it["src"]:
                it["src"] = parse_source(best[1].get("Source"))[:2]
        items.append(it)

    # A player leaving one LEC team and joining another shows as two rows;
    # fold them into one move.
    folded = []
    for i in items:
        if i["kind"] == "leave":
            j = next((x for x in items if x["kind"] == "join" and x["player"] == i["player"]
                      and x["team"] != i["team"]
                      and 0 <= (datetime.date.fromisoformat(x["date"]) - datetime.date.fromisoformat(i["date"])).days <= 45), None)
            if j:
                j["from"] = i["teamName"]
                j["fromTeam"] = i["team"]
                j["kind"] = "move"
                continue
        folded.append(i)

    folded.sort(key=lambda i: (i["date"], 0 if i["staff"] else 1), reverse=True)
    out = {
        "updated": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
        "source": "Leaguepedia",
        "sourceUrl": "https://lol.fandom.com/wiki/Portal:Transfers",
        "items": folded[:80],
    }
    print(f"{len(folded)} ticker items, {sum(1 for i in folded if any(s['sheep'] for s in i['src']))} via Sheep Esports")
    for i in folded[:8]:
        print("  ", i["date"], i["kind"], i["player"], i.get("from", ""), "->", i.get("to", i["teamName"]))
    if a.dry_run:
        return
    old = None
    if os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding="utf-8"))
        except ValueError:
            pass
    # Do not rewrite (and commit) the file for a new timestamp alone.
    if old and old.get("items") == out["items"]:
        print("no changes")
        return
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:   # the ticker is a nice-to-have: never break the stats job
        print(f"transfers not updated: {e}")
