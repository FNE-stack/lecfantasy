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
import argparse, datetime, html, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

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


RUMOR_STATUS = {"Rumor": "rumor", "Confirmed": "confirmed", "Disproven": "disproven"}


def fetch_post(url):
    """The text of an X post via X's public oEmbed endpoint (no key, no login).
    Only the words, author and date are kept; nothing of X's is embedded."""
    m = re.match(r"https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/([^/]+)/status/(\d+)", url)
    if not m:
        return None
    q = urllib.parse.urlencode({"url": f"https://twitter.com/{m.group(1)}/status/{m.group(2)}",
                                "omit_script": "true", "dnt": "true"})
    req = urllib.request.Request("https://publish.twitter.com/oembed?" + q, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError, TimeoutError):
        return None
    body = re.search(r"<p[^>]*>(.*?)</p>", j.get("html", ""), re.S)
    if not body:
        return None
    t = body.group(1)
    media = "pic.twitter.com" in t
    t = re.sub(r"<br\s*/?>", "\n", t)
    t = re.sub(r"<a [^>]*>(pic\.twitter\.com/\S+?)</a>", "", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = html.unescape(t).strip()
    date = re.search(r"</p>.*?<a [^>]*>([^<]+)</a>\s*</blockquote>", j.get("html", ""), re.S)
    return {"author": j.get("author_name", ""), "handle": m.group(1), "text": t[:600],
            "media": media, "when": date.group(1) if date else ""}


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

    # ── rumours: who is said to be going where (mostly Sheep Esports) ──────
    rr = cargo({
        "tables": "RosterRumors=R",
        "fields": "R.Date=Date,R.Status=Status,R.Player=Player,R.TeamStart=TeamStart,R.TeamEnd=TeamEnd,"
                  "R.RoleStart=RoleStart,R.RoleEnd=RoleEnd,R.SourceSite=SourceSite,R.SourceAuthors=SourceAuthors,"
                  "R.SourceLink=SourceLink,R.NotHappening=NotHappening,R.IsOver=IsOver",
        "where": f"R.Date >= '{since}' AND (R.TeamStart IN ({quote_list(code_of)}) OR R.TeamEnd IN ({quote_list(code_of)}))",
        "order_by": "R.Date DESC",
    })
    rumors, rseen = [], set()
    for r in rr:
        key = (r["Player"], r.get("TeamEnd"), r.get("SourceSite"), r.get("Date"))
        if key in rseen:
            continue
        rseen.add(key)
        status = RUMOR_STATUS.get(r.get("Status") or "", "rumor")
        if r.get("NotHappening") == "1":
            status = "disproven"
        url = (r.get("SourceLink") or "").strip()
        rumors.append({
            "date": (r.get("Date") or "")[:10],
            "player": clean_player(r["Player"]),
            "from": r.get("TeamStart") or "", "fromTeam": code_of.get(r.get("TeamStart")),
            "to": r.get("TeamEnd") or "", "toTeam": code_of.get(r.get("TeamEnd")),
            "role": PLAYER_ROLES.get(r.get("RoleEnd") or "", r.get("RoleEnd") or r.get("RoleStart") or ""),
            "status": status,
            "stay": (r.get("TeamStart") or "") == (r.get("TeamEnd") or ""),
            "site": r.get("SourceSite") or "",
            "authors": r.get("SourceAuthors") or "",
            "url": url if url.startswith("http") else "",
            "sheep": "sheep" in ((r.get("SourceSite") or "") + url).lower(),
        })
    print(f"{len(rumors)} rumours, {sum(1 for x in rumors if x['sheep'])} from Sheep Esports")

    # ── contracts that run past today (Leaguepedia knows only some) ───────
    contracts = {}
    try:
        for c in cargo({
            "tables": "Contracts=C", "fields": "C.Player=Player,C.Team=Team,C.ContractEnd=ContractEnd",
            "where": f"C.Team IN ({quote_list(code_of)}) AND C.ContractEnd > '{datetime.date.today().isoformat()}'",
        }):
            contracts[clean_player(c["Player"])] = {"team": code_of.get(c["Team"]), "end": (c.get("ContractEnd") or "")[:10]}
    except Exception as e:
        print(f"  contracts skipped: {e}")

    # ── the posts themselves: text of X posts used as a source ────────────
    old_posts = {}
    if os.path.exists(OUT):
        try:
            old_posts = json.load(open(OUT, encoding="utf-8")).get("posts", {})
        except ValueError:
            pass
    want = []
    for i in folded[:80]:
        for s2 in i["src"][:1]:
            want.append(s2["url"])
    for r in rumors[:80]:
        if r["url"]:
            want.append(r["url"])
    posts, fetched = {}, 0
    for u in dict.fromkeys(want):
        if not re.search(r"(?:x|twitter)\.com/[^/]+/status/", u):
            continue
        if u in old_posts:
            posts[u] = old_posts[u]
            continue
        if fetched >= 80:       # polite: the rest comes on the next run
            continue
        p = fetch_post(u)
        fetched += 1
        if p:
            posts[u] = p
        time.sleep(0.4)
    print(f"{len(posts)} posts ({fetched} fetched now)")

    out = {
        "updated": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
        "source": "Leaguepedia",
        "sourceUrl": "https://lol.fandom.com/wiki/Portal:Transfers",
        "items": folded[:80],
        "rumors": rumors[:120],
        "contracts": contracts,
        "posts": posts,
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
    if old and all(old.get(k) == out[k] for k in ("items", "rumors", "contracts", "posts")):
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
