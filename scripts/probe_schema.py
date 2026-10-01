#!/usr/bin/env python3
"""
probe_schema.py - confirms the Leaguepedia Cargo tables/fields this project
depends on actually exist.

It checks in two layers:

  1. DECLARATIONS (always, no login needed). Every Cargo table is declared by a
     normal wiki page, Module:CargoDeclare/<Table>, which plain `action=query`
     can read. Anonymous `cargoquery` is refused outright by Fandom, but this
     path is not, so the field names can be verified from anywhere. This is the
     check that catches schema drift - a renamed or removed field.

  2. LIVE ROWS (only with bot credentials). Actually runs the query and prints
     a real row, which additionally proves the --split string matches a real
     OverviewPage and that rows are populated. Needs LEAGUEPEDIA_USERNAME /
     LEAGUEPEDIA_PASSWORD because anonymous cargoquery returns 'ratelimited'
     on the very first request (verified 2026-10-01 from a clean IP, while
     plain action=query returned 200 - it is not a throttle you can wait out).

    python scripts/probe_schema.py --split "LEC/2026 Season/Summer Season"

Exit 0 = declared schema matches fetch_lec.py. Exit 1 = drift, and the output
names the exact field that moved.
"""
import argparse, json, os, re, sys, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_lec as F

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# (table, [fields fetch_lec.py relies on])
EXPECT = [
    ("TournamentPlayers",  ["Player", "Team", "Role"]),
    ("ScoreboardPlayers",  ["Link", "Team", "Champion", "Kills", "Deaths",
                            "Assists", "CS", "DateTime_UTC", "PlayerWin",
                            "Role", "Pentakills"]),
]


def declared_fields(table):
    """Field names from Module:CargoDeclare/<table>. Works without a login."""
    url = F.API + "?" + urllib.parse.urlencode({
        "action": "query", "prop": "revisions", "rvprop": "content",
        "rvslots": "main", "titles": "Module:CargoDeclare/" + table,
        "format": "json"})
    req = urllib.request.Request(url, headers={"User-Agent": F.UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        payload = json.loads(r.read().decode("utf-8"))
    page = next(iter(payload["query"]["pages"].values()))
    if "revisions" not in page:
        return None
    body = page["revisions"][0]["slots"]["main"]["*"]
    return re.findall(r'field\s*=\s*"([^"]+)"', body)


def probe_declaration(table, fields):
    print("\n-- %s (declaration) %s" % (table, "-" * max(0, 40 - len(table))))
    try:
        found = declared_fields(table)
    except Exception as e:
        print("  FAILED to read declaration: %s" % e)
        return False, []
    if found is None:
        print("  Module:CargoDeclare/%s does not exist - table renamed?" % table)
        return False, []
    missing = [f for f in fields if f not in found]
    if missing:
        print("  ! MISSING: %s" % missing)
        print("    declared fields: %s" % sorted(found))
        return False, missing
    print("  OK - all %d expected fields declared (of %d total)"
          % (len(fields), len(found)))
    return True, []


def probe_rows(table, fields, split):
    """Live query. Only reachable with credentials."""
    print("\n-- %s (live rows) %s" % (table, "-" * max(0, 40 - len(table))))
    try:
        rows = F.cargo(table, ",".join(fields),
                       where='%s.OverviewPage="%s"' % (table, split), limit=3)
    except SystemExit as e:
        print("  FAILED: %s" % e)
        return False
    if not rows:
        print("  no rows - the --split string probably does not match the "
              "Leaguepedia page title.")
        return False
    print("  %d row(s). first row verbatim:" % len(rows))
    print("    " + json.dumps(rows[0], ensure_ascii=False))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True)
    a = ap.parse_args()
    print("probing schema for split: %s" % a.split)

    ok, problems = True, {}
    for table, fields in EXPECT:
        good, missing = probe_declaration(table, fields)
        ok &= good
        if missing:
            problems[table] = missing

    print("\n" + "=" * 62)
    if not ok:
        print("SCHEMA DRIFT - the declared fields no longer match fetch_lec.py.")
        for t, m in problems.items():
            print("  %s: fix these field names in fetch_lec.py -> %s" % (t, m))
        return 1

    print("SCHEMA OK - every field fetch_lec.py reads is declared upstream.")

    F.login()
    if not F._authed:
        print("\nSkipped the live-row check (needs bot credentials).")
        print("  Still UNVERIFIED by this run:")
        print("    - that --split matches a real OverviewPage")
        print("    - that the split actually has rows")
        print("  To check those too, create a login at")
        print("  lol.fandom.com -> Special:BotPasswords, then set")
        print("  LEAGUEPEDIA_USERNAME / LEAGUEPEDIA_PASSWORD (env vars locally,")
        print("  repo secrets for the Action) and run this again.")
        return 0

    print("\nbot credentials present - checking live rows too")
    live = True
    for table, fields in EXPECT:
        live &= probe_rows(table, fields, a.split)
    print("\n" + "=" * 62)
    if not live:
        print("Declared schema is fine, but the live query returned nothing.")
        print("  Check the --split string against the Leaguepedia page title.")
        return 1
    print("LIVE OK - split name resolves and rows are populated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
