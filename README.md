# LEC Fantasy — Snake Draft

Fantasy-Liga für eine feste Gruppe. Läuft komplett online und kostenlos:
**GitHub Pages** für die Seiten, ein **Cloudflare Worker** als Draft-Schiedsrichter,
eine **GitHub Action** für die Daten.

Alles ist **eine Seite** mit echten Links (`#/spieler/<id>`, `#/team/G2`, `#/manager/m1` …),
gemeinsamer Navigation, Zurück-Taste und Handy-Ansicht mit Tab-Leiste. Installierbar
als App („Zum Startbildschirm hinzufügen").

| Bereich | Was |
|---|---|
| **Übersicht** `#/` | Tabelle der Manager, Top-Spieler, letzte Ergebnisse |
| **Mein Team** `#/mein-team` | eigener Bereich: Platz, Punkte, Ø/Woche, Kader mit nächstem Spiel und Form, Punkte pro Woche, nächste Spiele, letzte Spiele der eigenen Spieler |
| **Draft** `#/draft` | Login, Uhr („wer ist dran"), Spieler-Pool nach Punkten, Watchlist, bester Verfügbarer pro Rolle, Draft Board, Ton/Benachrichtigung wenn man dran ist |
| **Spieler** `#/spieler` | alle Spieler sortierbar; Spielerseite mit Form-Chart, Champion-Pool, Game-Log |
| **Teams** `#/teams` | alle LEC-Teams mit Bilanz, Kader, Ergebnissen |
| **Regeln** `#/regeln` | Punkte, Kader, Draft, Daten |
| `draft.html` | nur Host: Notfall-Werkzeug mit GitHub-Token (Undo, Sperren) |

`league.html` und `pick.html` leiten auf die neue Seite weiter — alte Links funktionieren.

## Wie es funktioniert

```
lolesports API --(Action, 2x täglich)--> data/teams.json      Teams, Kürzel, Logos
                                         data/players.json    Spieler, echte Namen, Fotos
                                         data/stats.json      K/D/A/CS/Sieg pro Spiel
                                         data/champions.json  Champion-Namen + Icons
                                         data/schedule.json   Spielplan + Ergebnisse ("nächstes Spiel")

Manager --(#/draft)--> Worker --(GitHub-Token)--> data/league.json   Picks
alle    --(Seite, nur lesen)-----------------------> alles oben
```

**Das Repo ist die Datenbank.** Schreiben darf nur der Worker; er hält den
GitHub-Token privat (eine statische Seite kann kein Geheimnis bewahren — ein Token
in `pick.html` hätte jeder). Er prüft bei jedem Pick: eingeloggt? am Zug? Spieler
frei? Rolle/Team-Limit ok? — mit genau denselben Regeln aus `scoring.js`, die
auch die Seiten benutzen.

## Daten: lolesports API

Dieselbe API, auf der lolesports.com läuft. **Braucht keinen Login.**

- **Teams**: voller Name, Kürzel (`G2`, `MKOI`), offizielles Logo — nur die
  Teams, die im Turnier wirklich spielen.
- **Spieler**: IGN, echter Name, Rolle, Team, Foto. Coaches werden ausgefiltert.
- **Spiele**: jedes Spiel nennt seine Spieler per `esportsPlayerId` — dieselbe ID
  wie in den Kadern. Stats hängen also per ID am Spieler, nie per Namensvergleich.
- **Sieger**: Die API hat pro Spiel kein Sieger-Feld, aber pro Serie den Endstand.
  Bo1 ist damit exakt; bei Bo3/Bo5 werden die Spiele nach Türme-Differenz sortiert
  und genau so viele Siege verteilt, wie der offizielle Endstand sagt. Geprüft am
  Summer Split 2026: **53/53 Serien stimmen.**
- **Inkrementell**: bereits geholte Spiele werden nicht neu geladen.

Turnier steht in `data/league.json` unter `tournament`: `"auto"` = das neueste
LEC-Turnier, das schon begonnen hat; oder fest, z. B. `"lec_split_3_2026"`.

## Online bringen

1. **GitHub-Token** — github.com → Settings → Developer settings → Fine-grained
   tokens. Nur Repo `FNE-stack/lecfantasy`, Rechte **Contents: Read and write** und
   **Workflows: Read and write**.
2. **Cloudflare** — kostenlos registrieren, einmal **Workers & Pages** öffnen
   (legt die `*.workers.dev`-Subdomain an), dann API-Token mit Vorlage
   **„Edit Cloudflare Workers"** und die **Account ID** notieren.
3. Alles in `~/lecfantasy.env` (liegt außerhalb des Repos, wird nie committed):
   ```
   GITHUB_TOKEN=github_pat_...
   CLOUDFLARE_API_TOKEN=...
   CLOUDFLARE_ACCOUNT_ID=...
   ```
4. `bash worker/deploy.sh` — legt den KV-Speicher an, hinterlegt den Token als
   Worker-Secret, deployt und trägt die Worker-URL in `pick.html` ein.
5. Committen und pushen. Danach ist alles live:
   - <https://fne-stack.github.io/lecfantasy/>

## Draft-Abend

Jeder öffnet die Seite → **Draft**, klickt auf einen freien Slot, wählt Namen und Passwort.
Wer zuerst kommt, hat den Slot — der Link ist die Einladung. Danach pickt jeder auf
dem eigenen Handy; die Seite zeigt, wer dran ist, sortiert die Spieler nach Punkten
im letzten Split und graut ab, was nicht erlaubt ist. Nach dem letzten Pick sperrt
der Draft sich selbst.

Ein Passwort vergessen? Den Eintrag `mgr:<id>` im KV-Speicher löschen
(`npx wrangler kv key delete --binding LEAGUE mgr:m2`), dann ist der Slot wieder frei.

## Punkte

| | Punkte |
|---|---|
| Kill | 3 |
| Tod | −1 |
| Assist | 1,5 |
| CS | 0,02 (= 2 pro 100) |
| Sieg | 2 |

Anpassbar unter `scoring` in `league.json`. `scoring.js` ist die **einzige** Stelle,
an der gerechnet und geregelt wird — Seiten und Worker benutzen dieselbe Datei.
Multikills/Pentakills gibt es nicht: die lolesports API liefert sie nicht.

## Neue Saison

`tournament` auf `"auto"` lassen (oder den neuen Slug eintragen), in `league.json`
`draft.picks` leeren und `draft.completed` auf `false` setzen. Die Kader holt die
Action automatisch neu.

## Tests

```bash
python scripts/test_scoring.py   # Regeln: Snake-Reihenfolge, Draft-Ende, Punkte (Python + JS vergleichen)
node worker/test_worker.mjs      # Worker: Login, Zugreihenfolge, Limits, gleichzeitige Picks, keine Token-Lecks
```

## Grenzen

- `swapsPerWeek` ist eine Absprache, wird nicht erzwungen.
- Keine Lineups pro Spieltag: alle gedrafteten Spieler zählen immer, auch die Bank.
- Die lolesports API ist nicht offiziell dokumentiert. Ändert sie sich, bricht der
  Fetch laut ab und lässt die alten Daten stehen.
