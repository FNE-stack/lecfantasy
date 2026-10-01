# LEC Fantasy — Snake Draft für die Boys

Eine kleine Fantasy-Liga für eine feste Gruppe. Läuft komplett auf **GitHub Pages**
— kein Server, keine Datenbank, keine Kosten.

- **`league.html`** — die öffentliche Liga-Seite. Tabelle, Kader, Spieler, Draft-Verlauf.
  Braucht **keinen Login**, für alle immer erreichbar.
- **`pick.html`** — die Draft-Seite **für die Boys**. Jeder setzt sich beim ersten
  Besuch Name + Passwort und pickt dann selbst, vom eigenen Handy.
- **`draft.html`** — Host-Werkzeug. Schreibt direkt mit eigenem Token, als
  Notnagel wenn beim Draft etwas klemmt.
- Daten liegen als JSON im Repo. Ein GitHub-Action-Job zieht die LEC-Stats.

## Wie es funktioniert

```
Leaguepedia  --(GitHub Action, 2x/Tag)-->  data/stats.json
                                           data/players.json
                                                  |
Die Boys --(pick.html)--> Worker --(Token)--> data/league.json
                          ^ prüft Zug + Regeln              |
                                                            v
Alle  --(league.html, read-only)-->  Tabelle & Kader
```

Der Trick: **das Repo ist die Datenbank.** Geschrieben wird ausschließlich über
die GitHub-API mit einem Token — und der liegt **im Worker**, nicht in der Seite.

Warum überhaupt ein Worker: GitHub Pages liefert nur statische Dateien aus. Eine
Seite, die selbst ins Repo schreiben kann, müsste den Token enthalten — und ein
Token in einer öffentlichen Seite ist ein Token, den **alle** haben. Dann könnte
jeder jeden Kader umschreiben. Der Worker ist die einzige Stelle mit dem Token,
prüft bei jedem Pick, ob der Absender wirklich dran ist und ob der Pick erlaubt
ist, und committet erst dann.

Wichtig: der Worker hat **keine eigene Regelkopie**. Er benutzt dasselbe
`scoring.js` wie die Seiten, kann also nie etwas anderes erlauben, als auf dem
Bildschirm stand.

## Einrichten

### 1. Repo + Pages — erledigt

Läuft schon:

- Repo: <https://github.com/FNE-stack/lecfantasy>
- Liga: <https://fne-stack.github.io/lecfantasy/league.html>
- Draft: <https://fne-stack.github.io/lecfantasy/draft.html>

> Das Repo ist **public**, weil Pages im Free-Plan nur öffentliche Repos
> ausliefert. Es enthält keine Secrets — der GitHub-Token liegt als Worker-Secret
> bei Cloudflare, die Leaguepedia-Zugangsdaten als Actions-Secrets. Beides wird
> nie committed.

### 2. Liga konfigurieren — `data/league.json`

```jsonc
"split": "LEC/2026 Season/Summer Season",  // muss exakt der Leaguepedia-Name sein
"managers": [ {"id":"fabi","name":"Fabi"}, … ],
"draft": { "order": ["fabi","boy2",…], "snake": true },
"roster": { "slots":["TOP","JNG","MID","BOT","SUP"], "bench":1, "maxPerTeam":2 },
"swapsPerWeek": 1
```

Namen und IDs der Manager anpassen. `order` ist die Draft-Reihenfolge in Runde 1;
bei `snake: true` dreht sie sich jede Runde.

### 3. Leaguepedia-Bot-Account — PFLICHT

Ohne Login geht gar nichts: Fandom lehnt anonymes `cargoquery` **komplett** ab.
Nachgemessen am 01.10.2026 von einer frischen IP ohne jeden vorherigen Request —
die allererste Anfrage kommt schon mit `{"error":{"code":"ratelimited"}}` zurück,
während normales `action=query` sauber mit 200 antwortet. Das ist also kein
Limit, das man aussitzen kann, sondern eine geschlossene Tür.

1. Auf <https://lol.fandom.com> einloggen (Fandom-Account reicht).
2. **Special:BotPasswords** → neuen Bot anlegen, Recht *Basic rights* / read.
3. Im Repo: **Settings → Secrets and variables → Actions → New secret**
   - `LEAGUEPEDIA_USERNAME` = `DeinUser@DeinBotName`
   - `LEAGUEPEDIA_PASSWORD` = das generierte Bot-Passwort

Damit gibt es 5000-Zeilen-Seiten und eine brauchbare Rate. **Ohne die Secrets
bricht `update-stats` sofort ab** — mit einer Meldung, die genau das sagt. Die
alten Daten bleiben dabei unangetastet.

### 4. Schema prüfen — VOR dem ersten echten Lauf

**Actions → probe-schema → Run workflow**

Der Job schreibt nichts. Er prüft in zwei Stufen:

1. **Deklarationen** — immer, *ohne Login*. Jede Cargo-Tabelle wird auf einer
   ganz normalen Wiki-Seite deklariert (`Module:CargoDeclare/<Tabelle>`), und
   die liest `action=query` problemlos. Genau das fängt Schema-Drift ab.
2. **Echte Zeilen** — nur mit Bot-Zugangsdaten. Beweist zusätzlich, dass der
   `split`-String auf eine echte `OverviewPage` passt und Zeilen da sind.

Ergebnis:

- `SCHEMA OK` → die Feldnamen stimmen.
- `SCHEMA DRIFT` → im Log steht, **welches Feld** sich geändert hat; nur in
  `fetch_lec.py` anpassen.
- *keine Zeilen* (nur Stufe 2) → der `split`-String passt nicht zum
  Leaguepedia-Seitentitel.

> **Stufe 1 ist am 01.10.2026 gelaufen: `SCHEMA OK`.** Alle 14 Felder, die
> `fetch_lec.py` liest, sind upstream deklariert — die Verifikation, die beim
> Bauen nicht möglich war, ist damit erledigt. Stufe 2 steht noch aus, weil
> dafür der Bot-Account nötig ist.

### 5. Stats holen

Action einmal manuell starten: **Actions → update-stats → Run workflow**.
Danach läuft sie 2x täglich (04:20 / 16:20 UTC).

Sie schreibt `data/players.json` (Draft-Pool) und `data/stats.json` (Punkte).
Bei Problemen bricht sie **ab, ohne die alten Daten zu überschreiben**.

### 6. Worker aufsetzen — einmalig, ~10 Minuten

Der Worker ist der Schiedsrichter beim Draft. Ohne ihn kann `pick.html` nichts
schreiben (und das ist Absicht).

**a) Fine-grained Token bauen**
GitHub → Settings → Developer settings → Fine-grained tokens → *Generate new*:

- **Repository access:** *Only select repositories* → nur `FNE-stack/lecfantasy`
- **Permissions → Repository permissions → Contents:** *Read and write*
- Ablaufdatum ruhig kurz halten; nach der Saison einfach löschen.

**b) Cloudflare**

```bash
cd worker
npm install
npx wrangler login                       # öffnet den Browser
npx wrangler kv namespace create LEAGUE  # gibt eine id aus
```

Die ausgegebene `id` in `worker/wrangler.toml` bei `kv_namespaces` eintragen.
Dort stehen auch `GITHUB_REPO`, `GITHUB_BRANCH` und `ALLOWED_ORIGIN` — die sind
schon richtig gesetzt, solange Repo und Pages-URL gleich bleiben.

```bash
npx wrangler secret put GITHUB_TOKEN     # Token aus (a) einfügen
npx wrangler deploy
```

`deploy` gibt eine URL aus, etwa `https://lecfantasy-draft.<dein-name>.workers.dev`.
Die in `pick.html` oben bei `DEFAULT_WORKER` eintragen, committen, fertig.

**c) Link verteilen**
Alle bekommen denselben Link: `https://fne-stack.github.io/lecfantasy/pick.html`.
Jeder wählt einmal seinen Slot und setzt Name + Passwort. **Wer zuerst kommt,
nimmt den Slot** — ein bereits übernommener Slot lässt sich nicht kapern. Es gibt
bewusst kein Passwort-Zurücksetzen; falls doch nötig, den Key `mgr:<id>` im
KV-Namespace löschen, dann ist der Slot wieder frei.

> **Kosten:** keine. Der Free-Plan von Workers erlaubt 100.000 Requests/Tag,
> ein Draft braucht ein paar hundert. Kreditkarte wird nicht verlangt.

**Vorher ausprobieren — ohne Cloudflare, ohne GitHub:**

```bash
node worker/devserver.mjs
# -> http://localhost:8787/pick.html?worker=http://localhost:8787
```

Das startet den echten Worker-Code lokal mit nachgebautem KV und GitHub. Picks
landen im Arbeitsspeicher, `data/` wird nicht angefasst, Neustart setzt alles
zurück. Damit lässt sich ein kompletter Draft durchklicken, bevor irgendwas live
geht.

### 7. Draften

1. Alle öffnen `pick.html`, loggen sich ein und sehen, wer dran ist
   (aktualisiert sich von selbst).
2. Wer dran ist, pickt. Illegale Picks sind ausgegraut **und** werden vom Worker
   nochmal abgelehnt: schon gedraftet, falsche Rolle, Team-Limit, nicht am Zug.
3. Nach dem letzten Pick sperrt sich der Draft **automatisch** (`completed`).

Die Picks landen als ganz normale Commits in `data/league.json` — man kann also
hinterher genau nachsehen, wer wann was genommen hat, und im Notfall
zurückrollen.

Wenn der Worker klemmt, bleibt `draft.html` als Host-Notnagel: eigener Token,
schreibt direkt, kennt dieselben Regeln.

## Punkte


| | Punkte |
|---|---|
| Kill | 3 |
| Tod | −1 |
| Assist | 1,5 |
| CS | 0,02 (= 2 pro 100) |
| Sieg | 2 |
| Pentakill | 10 |

Anpassbar unter `scoring` in `league.json`. `scoring.js` ist die **einzige**
Stelle, an der gerechnet wird — beide Seiten benutzen sie, also können Draft und
Tabelle nie unterschiedliche Zahlen zeigen.

## Wechsel nach dem Draft

Kader sind gesperrt. Ein Wechsel wird als Eintrag in `swaps` ergänzt:

```json
"swaps": [ { "manager":"fabi", "out":"G2_MID", "in":"FNC_MID", "week":3 } ]
```

`swapsPerWeek` begrenzt, wie viele pro Woche erlaubt sind (wird aktuell **nicht**
automatisch erzwungen — der Host trägt sie ein, das ist die Kontrolle).

## Testen ohne echte Daten

`data/players.json` und `data/stats.json` enthalten aktuell **Fixture-Daten**
(echte 2026-Teams, erfundene Spieler) mit `"fixture": true`, damit man die Seiten
sofort ausprobieren kann. Der erste Action-Lauf überschreibt sie mit echten Daten.

Logik-Tests:

```bash
python scripts/test_scoring.py     # Punkte + Snake-Reihenfolge
node   worker/test_worker.mjs     # Draft-Schiedsrichter (braucht kein Cloudflare)
```

Prüft Snake-Reihenfolge, Draft-Abschluss und Punkteberechnung. Wenn `node`
installiert ist, wird zusätzlich verglichen, dass `scoring.js` dieselben Zahlen
liefert wie die Python-Referenz.

## Stand der Saison

Die LEC-Saison 2026 ist am **20. September 2026 beendet**. Es gibt also gerade
keinen laufenden Split zum Draften — für einen echten Testlauf einen
abgeschlossenen Split in `split` eintragen (z. B. `LEC/2026 Season/Summer Season`),
dann hat man echte Stats und echte Punkte. Für die neue Saison einfach den
Split-Namen ändern, `picks` leeren und `completed` auf `false` setzen.

## Bekannte Grenzen

- **Leaguepedia-Schema** ist nicht offiziell garantiert. Ändert sich ein Feldname,
  bricht der Fetch — deshalb bricht das Skript laut ab und lässt die alten Daten
  stehen, statt sie mit Müll zu überschreiben.
- **Pentakills zählen** — `ScoreboardPlayers` hat ein Feld `Pentakills`, es wird
  geholt und verrechnet. **Triple- und Quadrakills gibt es dort nicht**, deshalb
  sind sie aus `scoring` entfernt, statt still auf 0 zu stehen.
- **`swapsPerWeek`** ist eine Absprache, keine erzwungene Regel.
