#!/usr/bin/env python3
"""
stamp.py - gives every script and stylesheet in index.html a fresh ?v= stamp.

GitHub Pages serves files with Cache-Control: max-age=600, so after an update
a browser can keep running the old app.js for up to 10 minutes - while talking
to the new Worker. That once made the admin login fail ("Name oder Passwort
falsch") right after it was changed. A new ?v= makes the browser fetch the new
files as soon as it has the new index.html.

Run before every push that changes the site:   python scripts/stamp.py
"""
import io, os, re, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
p = os.path.join(ROOT, "index.html")
s = io.open(p, encoding="utf-8").read()
v = time.strftime("%Y%m%d%H%M")
s2 = re.sub(r'((?:src|href)="(?:scoring|common|admin-ui|events-ui|app)\.js|href="theme\.css)(\?v=\d+)?"',
            lambda m: f'{m.group(1)}?v={v}"', s)
io.open(p, "w", encoding="utf-8", newline="\n").write(s2)
print(f"index.html stamped v={v} ({len(re.findall(r'\\?v=' + v, s2))} files)")
