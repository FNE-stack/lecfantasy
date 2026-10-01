# Projekt-Notizen / Handoff

Stand: **1. Oktober 2026**. Für die Fortsetzung mit Claude Code: Stand, offene
Punkte, Entscheidungen samt Begründung.

## Stand

- Seiten, Worker, Datenpipeline, Tests: **fertig und lokal verifiziert.**
- **Noch nicht online**, weil zwei Zugangsdaten fehlen, die nur Fabian anlegen
  kann (siehe README → „Online bringen"):
  1. GitHub fine-grained Token (Contents + Workflows: read/write). Ohne ihn
     scheitert auch `git push` — der gespeicherte Windows-Credential ist der
     richtige Account, hat aber kein Schreibrecht (`403 ... denied to FNE-stack`).
  2. Cloudflare API-Token + Account ID.
- Lokale Commits sind noch nicht gepusht.

Sobald `~/lecfantasy.env` existiert: `bash worker/deploy.sh`, dann pushen, dann
die Live-URLs im Browser prüfen.

## Dateien

| Datei | Zweck |
|---|---|
| `league.html` | Öffentlich. Tabelle, Kader, Spieler, Teams, Draft, Spielerkarte. |
| `pick.html` | Manager-Draftseite. Spricht nur mit dem Worker. |
| `draft.html` | Host-Notfallwerkzeug (direkter GitHub-Token): Undo, Sperren. |
| `index.html` | Redirect-Stub auf `league.html`. |
| `scoring.js` | Regeln + Punkte. Von allen Seiten **und** dem Worker importiert. |
| `common.js` | Daten laden + Anzeige (Namen, Logos, Fotos, Champion-Icons). |
| `worker/src/index.js` | Draft-Schiedsrichter: Login, Zugprüfung, Commit. |
| `worker/deploy.sh` | Idempotentes Deploy aus `~/lecfantasy.env`. |
| `worker/test_worker.mjs` | 8 Tests, KV + GitHub im Speicher gestubbt. |
| `worker/devserver.mjs` | Alles lokal ohne Cloudflare/GitHub — nur für Entwicklung. |
| `scripts/fetch_lolesports.py` | Teams/Spieler/Stats/Champions von lolesports. |
| `scripts/test_scoring.py` | Regeltests, inkl. Abgleich Python ↔ `scoring.js`. |

## Entscheidungen und warum

**1. Datenquelle lolesports statt Leaguepedia** (01.10.2026 umgestellt).
Leaguepedia lehnt anonymes `cargoquery` komplett ab (erste Anfrage von frischer
IP → `ratelimited`), bräuchte also einen Bot-Account. lolesports antwortet ohne
Login, hat offizielle Logos und Fotos, und Spiele referenzieren Spieler per
`esportsPlayerId` — exakte Joins statt Namensabgleich. Kosten: kein Sieger-Feld
pro Spiel (gelöst über Serienstand, 53/53 Serien verifiziert) und keine
Multikills (Pentakill-Wertung entfernt).

**2. Feed ohne „finished"-Frame.** Bei ~1 von 10 Spielen endet der Livestats-Feed,
ohne je `gameState: finished` zu senden. Ein letzter Frame, der sich bei
späteren Zeitpunkten nicht mehr ändert, wird als Spielende akzeptiert. Ohne das
fehlten 11 Spiele.

**3. Worker als einziger Schreiber.** Statische Seiten können keine Geheimnisse
halten. Der Worker hält den GitHub-Token, prüft Login und Regeln, und nutzt den
SHA der Datei als Sperre: zwei gleichzeitige Picks → einer gewinnt, der andere
wird neu geprüft (Test `recovers_from_a_lost_race` erzwingt einen echten 409).

**4. Slots statt fester Namen.** Manager heißen `m1`…`m4`; jeder setzt beim
Übernehmen seinen eigenen Anzeigenamen. Kein „Die Boys" mehr.

**5. Snake Draft statt Salary Cap.** Kompetitiver, keine Doppelvergabe.

## Getestet

- `test_scoring.py` 4/4, `test_worker.mjs` 8/8.
- Fetch gegen den echten Summer Split 2026: 10 Teams, 60 Spieler (alle mit Foto),
  137 Spiele, 1370 Zeilen, 0 ohne Spieler-Zuordnung, 53/53 Serienstände korrekt.
- Alle 101 gespielten Champions passen zu Data-Dragon-Schlüsseln.
- `league.html`, `pick.html`, `draft.html` headless mit echten Daten: 0 Konsolenfehler.
- Worker-Bundle baut (`wrangler deploy --dry-run`, 14 KB).

**Nicht getestet:** der echte Cloudflare-Deploy und der echte GitHub-Schreibpfad —
beides braucht die fehlenden Zugangsdaten.

## Ideen für später

- Spieltags-Ansicht („wer hat diese Woche gepunktet")
- Lineups pro Spieltag mit Deadline
- Trades zwischen Managern
- Discord-Webhook nach jedem Stats-Update
- Zusätzliche Wertungen aus dem `details`-Feed (Vision, Damage-Share, KP)
