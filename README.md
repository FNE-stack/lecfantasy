# LEC Fantasy — Snake Draft für die Boys

Eine kleine Fantasy-Liga für eine feste Gruppe. Läuft komplett auf **GitHub Pages**
— kein Server, keine Datenbank, keine Kosten.

- **`league.html`** — die öffentliche Liga-Seite. Tabelle, Kader, Spieler, Draft-Verlauf.
  Braucht **keinen Login**, für alle immer erreichbar.
- **`draft.html`** — die Draft-Seite. **Nur der Host** benutzt sie (braucht Token).
- Daten liegen als JSON im Repo. Ein GitHub-Action-Job zieht die LEC-Stats.

## Wie es funktioniert

```
Leaguepedia  --(GitHub Action, 2x/Tag)-->  data/stats.json
                                           data/players.json
                                                  |
Host  --(draft.html + Token)-->  data/league.json  |
                                                  v
Die Boys  --(league.html, read-only)-->  Tabelle & Kader
```

Der Trick: **das Repo ist die Datenbank.** Schreiben geht nur über die GitHub-API
mit einem Token — und den hat nur der Host. Alle anderen lesen die committeten
JSON-Dateien. Deshalb kann niemand die Liga kaputtmachen, aber jeder sieht alles.

## Einrichten

### 1. Repo + Pages — erledigt

Läuft schon:

- Repo: <https://github.com/FNE-stack/lecfantasy>
- Liga: <https://fne-stack.github.io/lecfantasy/league.html>
- Draft: <https://fne-stack.github.io/lecfantasy/draft.html>

> Das Repo ist **public**, weil Pages im Free-Plan nur öffentliche Repos
> ausliefert. Es enthält keine Secrets — der Token wird nie committed, er lebt
> nur im `localStorage` des Hosts.

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

### 3. Leaguepedia-Bot-Account (dringend empfohlen)

Anonymer Zugriff auf `cargoquery` ist auf **ca. 1 Anfrage pro Minute** begrenzt
und liefert nur 500 Zeilen pro Seite. Ein ganzer Split hat mehrere Tausend
Scoreboard-Zeilen — anonym also unbrauchbar.

1. Auf <https://lol.fandom.com> einloggen (Fandom-Account reicht).
2. **Special:BotPasswords** → neuen Bot anlegen, Recht *Basic rights* / read.
3. Im Repo: **Settings → Secrets and variables → Actions → New secret**
   - `LEAGUEPEDIA_USERNAME` = `DeinUser@DeinBotName`
   - `LEAGUEPEDIA_PASSWORD` = das generierte Bot-Passwort

Damit gibt es 5000-Zeilen-Seiten und eine brauchbare Rate. Ohne die Secrets läuft
alles trotzdem, nur sehr langsam (das Skript pausiert dann selbst 62 s pro Seite).

### 4. Schema prüfen — VOR dem ersten echten Lauf

**Actions → probe-schema → Run workflow**

Der Job schreibt nichts. Er prüft nur, ob die Cargo-Felder, auf die
`fetch_lec.py` zugreift, wirklich existieren, und gibt je Tabelle eine echte
Zeile aus. Ergebnis:

- `SCHEMA OK` → weiter zu Schritt 5.
- `SCHEMA DRIFT` → im Log steht, **welches Feld** sich geändert hat; nur in
  `fetch_lec.py` anpassen.
- *keine Zeilen* → der `split`-String passt nicht zum Leaguepedia-Seitentitel.

> Warum dieser Extra-Schritt: die Feldnamen stammen aus Leaguepedias
> öffentlichen Cargo-Definitionen, konnten beim Bauen aber **nicht** gegen die
> echte API geprüft werden — die IP des Autors war für `cargoquery` dauerhaft
> gesperrt (auch mit 70 s Abstand), während normales `action=query` lief. Der
> Probe-Job ist die Verifikation, die hier nicht möglich war.

### 5. Stats holen

Action einmal manuell starten: **Actions → update-stats → Run workflow**.
Danach läuft sie 2x täglich (04:20 / 16:20 UTC).

Sie schreibt `data/players.json` (Draft-Pool) und `data/stats.json` (Punkte).
Bei Problemen bricht sie **ab, ohne die alten Daten zu überschreiben**.

### 6. Draften

1. `draft.html` öffnen → **Verbindung…**
2. Repo (`user/lecfantasy`), Branch, und einen **fine-grained Token** mit
   *Contents: read and write* nur auf dieses Repo eintragen.
3. Reihum picken. Die Seite zeigt, wer am Zug ist, und **blockt illegale Picks**
   (schon gedraftet, Rolle fehlt noch, Team-Limit).
4. Am Ende **Draft sperren**. Danach sind die Kader fest.

Die Anderen öffnen währenddessen `league.html` → Tab **Draft** und sehen die Picks
live (Auto-Refresh alle 2 Minuten).

## Punkte

| | Punkte |
|---|---|
| Kill | 3 |
| Tod | −1 |
| Assist | 1,5 |
| CS | 0,02 (= 2 pro 100) |
| Sieg | 2 |

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
python scripts/test_scoring.py
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
- **Pentakills/Multikills** sind in der Punktetabelle vorgesehen, werden aber von
  `ScoreboardPlayers` nicht geliefert. Sie zählen erst, wenn sie manuell in
  `stats.json` ergänzt werden.
- **`swapsPerWeek`** ist eine Absprache, keine erzwungene Regel.
