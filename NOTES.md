# Projekt-Notizen / Handoff

Stand: **1. Oktober 2026**. Diese Datei ist für die Fortsetzung auf einem anderen
PC mit Claude Code gedacht — sie enthält den Stand, die offenen Punkte und die
Entscheidungen samt Begründung, damit nichts neu hergeleitet werden muss.

---

## Was das ist

Fantasy-Liga (LEC, Snake Draft) für eine feste Freundesgruppe. Vollständig
statisch auf GitHub Pages, **ohne Server**. Das Repo ist die Datenbank.

Entstanden, weil es keine funktionierende LEC-Fantasy-Seite mehr gibt. Ziel:
**fertig und getestet, bevor die Saison 2027 (nach Worlds) startet** — die
Saison 2026 endete am 20.09.2026, es gibt also gerade keinen laufenden Split.

## Dateien

| Datei | Zweck |
|---|---|
| `league.html` | Öffentliche Liga-Seite. Tabelle/Kader/Spieler/Draft. Kein Login. |
| `draft.html` | Draft-Oberfläche. **Nur Host**, braucht GitHub-Token. |
| `index.html` | **Nur Redirect-Stub** auf `league.html` (siehe Entscheidung 1). |
| `scoring.js` | Punkte + Draft-Regeln. Einzige Rechenstelle, von beiden Seiten genutzt. |
| `data/league.json` | Liga-Config, Manager, Draft-Picks, Swaps. **Die einzige Datei, die die Draft-Seite schreibt.** |
| `data/players.json` | Draft-Pool. Wird von der Action überschrieben. |
| `data/stats.json` | Spielerstatistiken. Wird von der Action überschrieben. |
| `scripts/fetch_lec.py` | Holt Rosters+Stats von Leaguepedia. |
| `scripts/probe_schema.py` | Prüft, ob die Cargo-Feldnamen noch stimmen. Schreibt nichts. |
| `scripts/resolve_split.py` | Liest den Split-Namen für die Action. |
| `scripts/test_scoring.py` | Logik-Tests (Snake-Order, Punkte, Draft-Ende). |

---

## Entscheidungen und warum

**1. Die Liga-Seite heißt `league.html`, nicht `index.html`.**
Ausdrücklicher Wunsch — es existiert schon ein anderes `index`. `index.html` ist
hier nur ein 8-Zeilen-Redirect, weil GitHub Pages bei einer nackten Verzeichnis-URL
sonst 404 liefert. Falls das störend ist: `index.html` löschen, dann muss die URL
immer `/league.html` enthalten.

**2. Nur der Host kann schreiben.**
Gefordert war: „niemand soll jederzeit editieren können, aber Daten immer
sichtbar". Deshalb: Schreibzugriff ausschließlich über die GitHub-API mit einem
fine-grained Token, den nur der Host im `localStorage` hat. Alle anderen lesen
die committeten JSON-Dateien. Eine Variante mit geteiltem Token wurde verworfen —
eine statische Seite kann kein Geheimnis bewahren, jeder mit der URL hätte
schreiben können.

**3. Daten-Fetch läuft in GitHub Actions, nicht im Browser.**
Drei Gründe: (a) `lol.fandom.com` sendet keine CORS-Header, der Browser kann die
API nicht aufrufen; (b) Rate-Limits treffen pro IP, ein Runner hat eine saubere;
(c) bei Schema-Änderungen ist nur eine Datei zu reparieren.

**4. Snake Draft statt Salary Cap.**
Gewählt, weil kompetitiver und weil keine Spieler doppelt vergeben werden.
Nebeneffekt: einfacher, kein Preis-Modell nötig.

---

## ⚠️ Der eine offene Punkt: Leaguepedia-Schema ist UNVERIFIZIERT

Das ist das Wichtigste in dieser Datei.

`fetch_lec.py` benutzt diese Tabellen/Felder:

```
TournamentPlayers : Player, Team, Role
ScoreboardPlayers : Link, Team, Champion, Kills, Deaths, Assists, CS,
                    DateTime_UTC, PlayerWin, Role
```

Die Namen stammen aus Leaguepedias öffentlichen Cargo-Definitionen
(`Module:CargoDeclare/ScoreboardPlayers`), **wurden aber nie gegen eine echte
API-Antwort geprüft.** Grund: Die IP des Entwicklungsrechners war für
`cargoquery` dauerhaft gesperrt — auch mit 70 s Abstand kam immer
`{"error":{"code":"ratelimited"}}`. Diagnose dazu:

- `action=query&meta=siteinfo` lief **einwandfrei** → die API an sich ist erreichbar.
- `action=cargoquery` lieferte **immer** `ratelimited` → es ist cargo-spezifisch.
- Ursache laut mediawiki-api-Mailingliste: anonymer Cargo-Zugriff bei Fandom ist
  auf **ca. 1 Anfrage/Minute** begrenzt, Seiten max. 500 Zeilen.

**Erste Aufgabe auf dem neuen PC:**

```bash
# lokal, falls die IP dort nicht gesperrt ist:
python scripts/probe_schema.py --split "LEC/2026 Season/Summer Season"

# oder im Repo: Actions -> probe-schema -> Run workflow
```

Ergebnis `SCHEMA OK` → alles gut. `SCHEMA DRIFT` → das Log nennt das falsche
Feld, nur in `fetch_lec.py` korrigieren.

---

## Setup-Reihenfolge

1. **Repo anlegen** (`lecfantasy`), diesen Ordner pushen (Befehle unten).
2. **Pages aktivieren**: Settings → Pages → Branch `main`, Ordner `/`.
3. **Manager umbenennen** in `data/league.json` (`fabi`, `boy2`, … sind
   Platzhalter). `id` wird intern benutzt, `name` wird angezeigt.
4. **Leaguepedia-Bot-Passwort** anlegen (lol.fandom.com → `Special:BotPasswords`)
   und als Repo-Secrets setzen:
   - `LEAGUEPEDIA_USERNAME` = `User@BotName`
   - `LEAGUEPEDIA_PASSWORD` = generiertes Passwort

   Ohne das: 500-Zeilen-Seiten und ~1 Anfrage/Minute. Ein ganzer Split hat
   mehrere Tausend Zeilen → anonym praktisch unbrauchbar. Mit Bot: 5000 Zeilen.
5. **`probe-schema` laufen lassen** (siehe oben).
6. **`update-stats` laufen lassen** → füllt `players.json` + `stats.json`.
7. **Trockenübung**: einen *abgeschlossenen* Split als `split` eintragen und
   einen kompletten Draft durchspielen. Genau dafür ist die Off-Season da.

---

## Was getestet ist (und was nicht)

**Getestet:**
- `scripts/test_scoring.py` → 4/4. Snake-Reihenfolge ergibt
  `fabi boy2 boy3 boy4 boy4 boy3 boy2 fabi`, Draft endet sauber bei 24 Picks
  (4 Manager × 6), Punkte stimmen mit Handrechnung (31,1 / 0 / −5).
- Kompletter 24-Pick-Draft simuliert, mit geprüften Invarianten: keine
  Doppel-Picks, gleich große Kader, bei jedem Manager alle 5 Rollen besetzt,
  Team-Limit (`maxPerTeam: 2`) eingehalten. Tabelle ergab 1279,6 → 1099,7.
- Beide Workflow-YAMLs parsen (mit `pyyaml` geprüft).
- `resolve_split.py` in beiden Pfaden (aus `league.json` und per `INPUT_SPLIT`).

**Nicht getestet:**
- Die Leaguepedia-Abfragen selbst (siehe offener Punkt oben).
- Der GitHub-Schreibpfad in `draft.html` — die Conflict-Retry-Logik ist aus
  `warhub.user.js` übernommen und dort bewährt, hier aber nie gegen ein echtes
  Repo gelaufen. **Beim ersten Pick darauf achten, dass der Commit erscheint.**
- `scoring.js` im Browser gegen die Python-Referenz — `node` war auf dem
  Entwicklungsrechner nicht installiert, der Vergleichstest wurde übersprungen.
  Auf einem PC mit node läuft er automatisch mit.

---

## Aktuelle Platzhalter-Daten

`data/players.json` und `data/stats.json` enthalten **Fixture-Daten**, markiert
mit `"fixture": true`: echte 2026er LEC-Teams (G2, Fnatic, Karmine Corp,
Movistar KOI, Team Vitality, Team Heretics, GIANTX, SK Gaming, Natus Vincere,
Shifters), aber **erfundene Spielernamen** (`G2E_MID` usw.) und Zufallsstatistik
aus 9 Spieltagen. Nur damit die Seiten sofort klickbar sind. Der erste
`update-stats`-Lauf überschreibt beides.

Echte Rosters wurden absichtlich **nicht** eingetragen — die Spielernamen waren
nicht zuverlässig zu ermitteln, und erfundene Namen als echt zu verkaufen wäre
schlimmer als ein offensichtlicher Platzhalter.

---

## Bekannte Grenzen

- **Multikills** (Triple/Quadra/Penta) stehen in der Punktetabelle, werden von
  `ScoreboardPlayers` aber nicht geliefert → zählen aktuell nie. Entweder manuell
  in `stats.json` ergänzen oder aus `scoring` entfernen.
- **`swapsPerWeek`** wird nicht erzwungen. Der Host trägt Swaps in `league.json`
  ein; das ist die Kontrolle.
- **Lineups pro Spieltag** gibt es nicht. Alle gedrafteten Spieler zählen immer,
  auch die Bank. Wer echtes Starten/Benchen will, muss `lineups` in `league.json`
  (existiert schon als leeres Objekt) und die Auswertung in `scoring.js` nutzen.
- **Kein Waiver/Trade-System.**

## Ideen für später

- Spieltags-Ansicht („wer hat diese Woche gepunktet")
- Lineups pro Spieltag mit Deadline
- Trades zwischen Managern (Host bestätigt)
- Playoffs/Head-to-Head statt reiner Punktesumme
- Discord-Webhook nach jedem `update-stats`-Lauf

---

## Push-Befehle

Repo `lecfantasy` auf GitHub anlegen (leer, ohne README), dann:

```bash
cd /c/Users/Administrator/OneDrive/lecfantasy
git init -b main
git add -A
git commit -m "LEC Fantasy: snake draft league for GitHub Pages"
git remote add origin https://github.com/FNE-stack/lecfantasy.git
git push -u origin main
```

Danach Pages aktivieren. URL wird:
`https://FNE-stack.github.io/lecfantasy/` → leitet auf `league.html`.

> Das Repo darf public sein — es enthält **keine** Secrets. Der GitHub-Token des
> Hosts liegt nur im Browser-`localStorage`, die Leaguepedia-Zugangsdaten nur in
> den Actions-Secrets.
