#!/usr/bin/env python3
"""
test_scoring.py — verifies scoring.js by running it in a JS engine if one is
available, else by re-implementing the same rules in Python and checking they
agree on hand-computed cases.

The point is to catch draft-rule bugs (duplicate picks, snake order, role
limits) BEFORE draft night, when they would be very annoying.
"""
import json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def load_league():
    with open(os.path.join(ROOT, "data", "league.json"), encoding="utf-8") as f:
        lg = json.load(f)
    # a fresh season starts in the lobby with nobody in it - the rule tests
    # need a draft to run, so give them four managers of their own
    if not lg["draft"].get("order"):
        lg["managers"] = [{"id": f"m{i}", "name": f"M{i}"} for i in range(1, 5)]
        lg["draft"]["order"] = [m["id"] for m in lg["managers"]]
    lg["draft"]["status"] = "live"
    return lg


# ── Python mirror of scoring.js (kept deliberately literal) ─────────────────
def game_points(g, s):
    p = g.get("k", 0) * s["kill"] + g.get("d", 0) * s["death"] \
        + g.get("a", 0) * s["assist"] + g.get("cs", 0) * s.get("cs10", 0)
    if g.get("win"):
        p += s["win"]
    return round(p, 2)


def current_picker(league):
    order = league["draft"]["order"]
    n = len(league["draft"]["picks"])
    slots = len(league["roster"]["slots"]) + league["roster"].get("bench", 0)
    if n >= len(order) * slots:
        return None
    rnd, idx = divmod(n, len(order))
    if league["draft"]["snake"] and rnd % 2 == 1:
        idx = len(order) - 1 - idx
    return order[idx]


def test_snake_order():
    lg = load_league()
    order = lg["draft"]["order"]
    seq = []
    for _ in range(len(order) * 2):
        who = current_picker(lg)
        seq.append(who)
        lg["draft"]["picks"].append({"manager": who, "player": f"p{len(seq)}"})
    expect = order + order[::-1]
    assert seq == expect, f"snake order wrong:\n got {seq}\n want {expect}"
    return f"{len(seq)} picks: {' '.join(seq)}"


def test_draft_completes():
    lg = load_league()
    order = lg["draft"]["order"]
    slots = len(lg["roster"]["slots"]) + lg["roster"].get("bench", 0)
    total = len(order) * slots
    n = 0
    while True:
        who = current_picker(lg)
        if who is None:
            break
        lg["draft"]["picks"].append({"manager": who, "player": f"p{n}"})
        n += 1
        assert n <= total + 1, "draft never terminated"
    assert n == total, f"expected {total} picks, draft ended after {n}"
    # everyone picks the same number of times
    counts = {}
    for p in lg["draft"]["picks"]:
        counts[p["manager"]] = counts.get(p["manager"], 0) + 1
    assert len(set(counts.values())) == 1, f"uneven picks: {counts}"
    return f"{n} picks, {slots} each for {len(order)} managers"


def test_points():
    s = load_league()["scoring"]
    # 5/2/7, 280 cs, win: 15 - 2 + 10.5 + 5.6 + 2 = 31.1
    got = game_points({"k": 5, "d": 2, "a": 7, "cs": 280, "win": True}, s)
    assert abs(got - 31.1) < 1e-9, f"expected 31.1, got {got}"
    # 0/0/0 loss = 0
    assert game_points({"k": 0, "d": 0, "a": 0, "cs": 0, "win": False}, s) == 0
    # deaths can go negative
    assert game_points({"k": 0, "d": 5, "a": 0, "cs": 0, "win": False}, s) == -5
    return "31.1 / 0 / -5 as expected"


def test_js_engine_agrees():
    """If node exists, run scoring.js on the same cases and compare."""
    node = shutil.which("node") or shutil.which("nodejs")
    if not node:
        return "SKIPPED (no node on this machine)"
    lg = load_league()
    harness = """
    global.window = global;
    require(%s);
    const S = global.LECScoring;
    const lg = %s;
    const s = lg.scoring;
    const out = {
      p1: S.gamePoints({k:5,d:2,a:7,cs:280,win:true}, s),
      p2: S.gamePoints({k:0,d:0,a:0,cs:0,win:false}, s),
      p3: S.gamePoints({k:0,d:5,a:0,cs:0,win:false}, s),
      order: []
    };
    const l2 = JSON.parse(JSON.stringify(lg));
    for (let i=0;i<lg.draft.order.length*2;i++){
      const w = S.currentPicker(l2);
      out.order.push(w);
      l2.draft.picks.push({manager:w, player:'p'+i});
    }
    console.log(JSON.stringify(out));
    """ % (json.dumps(os.path.join(ROOT, "scoring.js").replace("\\", "/")),
           json.dumps(lg))
    r = subprocess.run([node, "-e", harness], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise AssertionError("node failed: " + r.stderr[:400])
    got = json.loads(r.stdout.strip().splitlines()[-1])
    assert abs(got["p1"] - 31.1) < 1e-9, f"js p1={got['p1']}"
    assert got["p2"] == 0 and got["p3"] == -5, f"js p2/p3={got['p2']}/{got['p3']}"
    expect = lg["draft"]["order"] + lg["draft"]["order"][::-1]
    assert got["order"] == expect, f"js snake order {got['order']} != {expect}"
    return "node agrees with python on points + snake order"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    fails = 0
    for t in tests:
        try:
            msg = t()
            print(f"  ok  {t.__name__}: {msg}")
        except AssertionError as e:
            fails += 1
            print(f"  FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - fails}/{len(tests)} passed")
    sys.exit(1 if fails else 0)
