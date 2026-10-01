#!/usr/bin/env python3
"""Prints `value=<split>` for the Action's $GITHUB_OUTPUT.

Uses $INPUT_SPLIT when the workflow was dispatched with one, else the `split`
field in data/league.json. Lives in its own file so the workflow needs no
inline heredoc (indentation inside `run:` blocks is easy to break).
"""
import json, os, sys

split = (os.environ.get("INPUT_SPLIT") or "").strip()
if not split:
    try:
        with open("data/league.json", encoding="utf-8") as f:
            split = json.load(f)["split"]
    except Exception as e:
        print(f"could not read split from data/league.json: {e}", file=sys.stderr)
        sys.exit(1)
if not split:
    print("no split configured", file=sys.stderr)
    sys.exit(1)
print("value=" + split)
