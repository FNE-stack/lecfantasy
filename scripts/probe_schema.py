#!/usr/bin/env python3
"""
probe_schema.py — confirms the Leaguepedia Cargo tables/fields this project
depends on actually exist, and prints one real row of each.

WHY THIS EXISTS: the field names in fetch_lec.py come from Leaguepedia's public
Cargo table definitions, but they were never confirmed against a live response
while this was built — the author's IP was hard-blocked for `cargoquery`
(anonymous cargo access is ~1 request/minute and this IP stayed blocked even at
70s spacing, while plain `action=query` worked fine). So rather than trust the
docs, run this once from somewhere that can reach the API — a GitHub Actions
runner, or your own machine — and it will either confirm the schema or name the
exact field that moved.

    python scripts/probe_schema.py --split "LEC/2026 Season/Summer Season"

Exit code 0 = schema matches what fetch_lec.py expects. Non-zero = drift, and
the output says which field is missing.
"""
import argparse, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_lec as F

# (table, [fields fetch_lec.py relies on])
EXPECT = [
    ("TournamentPlayers",  ["Player", "Team", "Role"]),
    ("ScoreboardPlayers",  ["Link", "Team", "Champion", "Kills", "Deaths",
                            "Assists", "CS", "PlayerWin"]),
]


def probe(table, fields, split):
    print(f"\n── {table} " + "─" * (58 - len(table)))
    try:
        rows = F.cargo(table, ",".join(fields),
                       where=f'{table}.OverviewPage="{split}"', limit=3)
    except SystemExit as e:
        print(f"  FAILED: {e}")
        return False, []
    if not rows:
        print("  no rows returned — either the split name is wrong, or the "
              "table/OverviewPage filter changed.")
        return False, []
    print(f"  {len(rows)} row(s). first row verbatim:")
    print("    " + json.dumps(rows[0], ensure_ascii=False))
    got = set(rows[0].keys())
    # Cargo returns spaces where the query used underscores
    norm = {k.replace(" ", "_") for k in got}
    missing = [f for f in fields
               if f not in got and f.replace("_", " ") not in got
               and f not in norm]
    if missing:
        print(f"  ⚠ MISSING: {missing}")
        print(f"    fields actually present: {sorted(got)}")
        return False, missing
    print("  ✓ all expected fields present")
    return True, []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True)
    a = ap.parse_args()
    print(f"probing schema for split: {a.split}")
    F.login()
    print(f"mode: {'bot' if F._authed else 'anonymous (slow)'}")

    ok = True
    problems = {}
    for i, (table, fields) in enumerate(EXPECT):
        if i and not F._authed:
            print("\n  (waiting 65s — anonymous cargo limit)")
            time.sleep(65)
        good, missing = probe(table, fields, a.split)
        ok &= good
        if missing:
            problems[table] = missing

    print("\n" + "=" * 62)
    if ok:
        print("SCHEMA OK — fetch_lec.py field names match the live API.")
        return 0
    print("SCHEMA DRIFT or bad split name.")
    for t, m in problems.items():
        print(f"  {t}: fix these field names in fetch_lec.py -> {m}")
    print("\nIf every table returned zero rows, check the --split string against\n"
          "the Leaguepedia page title, e.g. 'LEC/2026 Season/Summer Season'.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
