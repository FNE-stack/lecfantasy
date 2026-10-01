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
| `pick.html` | Draft-Seite **für die Boys**. Login, eigener Kader, selbst picken. |
| `worker/src/index.js` | Cloudflare Worker. Einzige Stelle mit GitHub-Token. Schiedsrichter. |
| `worker/test_worker.mjs` | Worker-Tests, komplett offline (KV + GitHub nachgebaut). |
| `worker/devserver.mjs` | Alles lokal durchklicken, ohne Cloudflare und ohne GitHub. |
| `scoring.js` | Punkte + Draft-Regeln. Einzige Rechenstelle — Seiten **und** Worker. |
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

**2. ~~Nur der Host kann schreiben.~~ → GEÄNDERT am 01.10.2026.**

*Alte Entscheidung:* „niemand soll jederzeit editieren können, aber Daten immer
sichtbar" → Schreibzugriff nur per Host-Token im `localStorage`.

*Neu gefordert:* jeder soll sich einloggen, seinen Kader sehen und **selbst
picken**. Das ist die Umkehrung der alten Anforderung, bewusst so entschieden.

Der Grund, warum die alte Lösung nicht einfach erweitert werden konnte, bleibt
richtig und ist jetzt der Kern des Designs: **eine statische Seite kann kein
Geheimnis bewahren.** Gäbe man `pick.html` einen Token, hätte ihn jeder Besucher
und könnte jeden Kader umschreiben — schlechter als der Host-only-Zustand.

*Lösung:* ein Cloudflare Worker (`worker/src/index.js`) als einzige Stelle mit
Token. Die Seite schickt nur „ich will Spieler X", der Worker prüft Session, Zug
und Regeln und committet. Verworfen wurden:

- **Supabase** — könnte alles, hätte aber „das Repo ist die Datenbank" ersetzt
  und deutlich mehr Umbau bedeutet.
- **Alle als GitHub-Collaborator mit eigenem Token** — null Infrastruktur, aber
  GitHub-Rechte gelten nicht pro Datei: jeder hätte jeden Kader ändern können,
  und drei Leute hätten GitHub-Tokens basteln müssen.

`draft.html` bleibt unverändert als Host-Notnagel.

**3. Daten-Fetch läuft in GitHub Actions, nicht im Browser.**
Drei Gründe: (a) `lol.fandom.com` sendet keine CORS-Header, der Browser kann die
API nicht aufrufen; (b) Rate-Limits treffen pro IP, ein Runner hat eine saubere;
(c) bei Schema-Änderungen ist nur eine Datei zu reparieren.

**4. Snake Draft statt Salary Cap.**
Gewählt, weil kompetitiver und weil keine Spieler doppelt vergeben werden.
Nebeneffekt: einfacher, kein Preis-Modell nötig.

---

## ✅ ERLEDIGT (01.10.2026): Leaguepedia-Schema ist verifiziert

*War der wichtigste offene Punkt. Ergebnis: `SCHEMA OK`, nichts zu reparieren.*

`fetch_lec.py` benutzt diese Tabellen/Felder:

```
TournamentPlayers : Player, Team, Role
ScoreboardPlayers : Link, Team, Champion, Kills, Deaths, Assists, CS,
                    DateTime_UTC, PlayerWin, Role
```

Alle 14 Felder sind geprüft und **existieren** — plus `Pentakills`, siehe unten.

**Die alte Diagnose war falsch.** Es lag nicht an der IP des Entwicklungsrechners.
Derselbe Test von einem anderen PC, anderer IP, ohne jeden vorherigen Request:

- `action=query&meta=siteinfo` → **HTTP 200**, sauber.
- allererstes `action=cargoquery` → sofort `{"error":{"code":"ratelimited"}}`.

Fandom lehnt anonymes `cargoquery` also schlicht **generell** ab. Kein Limit, das
man aussitzen kann → der Bot-Account ist **Pflicht**, nicht „empfohlen", und der
Actions-Runner läuft ohne Secrets in exakt dieselbe Wand.

**Wie es trotzdem verifiziert wurde:** Cargo-Tabellen werden auf ganz normalen
Wiki-Seiten deklariert (`Module:CargoDeclare/<Tabelle>`), und die liest
`action=query` ohne Login. `probe_schema.py` macht das jetzt als Stufe 1:

```bash
python scripts/probe_schema.py --split "LEC/2026 Season/Summer Season"
# -> SCHEMA OK - every field fetch_lec.py reads is declared upstream
```

Noch **nicht** verifiziert (braucht den Bot-Account, Stufe 2 des Probes):
ob der `split`-String auf eine echte `OverviewPage` passt und ob Zeilen da sind.

---

## Setup-Reihenfolge

1. ~~Repo anlegen + pushen~~ — **erledigt**, siehe unten.
2. ~~Pages aktivieren~~ — **erledigt**.
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
- **Worker: 8/8** (`node worker/test_worker.mjs`) — Slot übernehmen, zweite
  Übernahme abgelehnt, falsches Passwort, Pick ohne Login, Pick wenn man nicht
  dran ist, Doppelpick, Team-Limit, kompletter 24-Pick-Draft mit Auto-Sperre,
  zwei gleichzeitige Picks (genau einer gewinnt), echter 409 mit Recovery, und
  dass weder Token noch Passwort je in einer Antwort auftauchen.
- **`pick.html` im echten Browser** (headless Chromium): Login, Kader, Pool,
  Pick committet, Uhr rückt weiter, 0 Konsolenfehler.
- `resolve_split.py` in beiden Pfaden (aus `league.json` und per `INPUT_SPLIT`).

**Nicht getestet:**
- Die Leaguepedia-*Abfragen* selbst — die Feldnamen sind verifiziert (siehe oben),
  ein echter `cargoquery`-Durchlauf braucht aber den Bot-Account.
- Der GitHub-Schreibpfad gegen ein **echtes** Repo. Die Conflict-Retry-Logik ist
  gegen einen nachgebauten GitHub getestet (inkl. erzwungenem 409), aber noch nie
  gegen api.github.com gelaufen. **Beim ersten echten Pick prüfen, dass der
  Commit erscheint.**
- Der Worker **deployed** bei Cloudflare — bisher nur lokal (`devserver.mjs`).
- ~~`scoring.js` gegen die Python-Referenz~~ — **erledigt 01.10.2026**: node 22
  ist hier da, `test_js_engine_agrees` läuft mit und stimmt überein, inkl. der
  neuen Pentakill-Wertung.

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

- **Multikills**: `ScoreboardPlayers` hat `Pentakills` (Integer) — wird jetzt
  geholt und verrechnet, mit Test in beiden Engines. **Triple/Quadra existieren
  dort nicht** und sind aus `scoring` raus, statt still 0 zu zählen.
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

## Repo / Deployment — ist LIVE

Am 01.10.2026 angelegt und gepusht:

- **Repo:** <https://github.com/FNE-stack/lecfantasy> (public)
- **Liga-Seite:** <https://fne-stack.github.io/lecfantasy/league.html>
- **Draft-Seite:** <https://fne-stack.github.io/lecfantasy/draft.html>
- Die nackte URL `.../lecfantasy/` leitet per Stub auf `league.html`.

Public, weil GitHub Pages im Free-Plan nur öffentliche Repos ausliefert. Das ist
unkritisch: das Repo enthält **keine** Secrets (wurde gegen Token-Muster
geprüft). Der GitHub-Token des Hosts liegt nur im Browser-`localStorage`, die
Leaguepedia-Zugangsdaten nur in den Actions-Secrets.

Auf einem neuen PC einfach klonen:

```bash
git clone https://github.com/FNE-stack/lecfantasy.git
cd lecfantasy
python scripts/test_scoring.py        # 4/4 erwartet
```

Beide Workflows (`probe-schema`, `update-stats`) sind im Repo registriert und
`active`, aber **noch nie gelaufen**.
