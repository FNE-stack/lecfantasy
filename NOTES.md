# Projekt-Notizen / Handoff

Stand: **2. Oktober 2026**. Für die Fortsetzung mit Claude Code: Stand, offene
Punkte, Entscheidungen und Fallen, in die man schon getreten ist.

## Stand

**LIVE, leer, bereit.** Liga im Status *Anmeldung*, 0 Mitglieder, frischer
Einladungslink im Admin. Alle Tests grün (Regeln 17/17, Worker 24/24, Punkte 4/4).
Saison 2026 komplett geladen (3 Splits, 382 Spiele, 186/186 Serien = offiziell).
Live per echtem Browser geprüft: Einladung → Beitreten → Login → Draft → Pick →
Admin-Pick → Undo → Restore → Health; Layout auf 5 Breiten × alle Seiten × alle
Admin-Tabs; ausgeloggt keine Mitgliedsdaten sichtbar.

- Seite: <https://fne-stack.github.io/lecfantasy/>
- Worker: <https://lecfantasy-draft.fabian-neidl.workers.dev>
- Zugangsdaten: `~/lecfantasy.env`. Deploy: `bash worker/deploy.sh`.

## Offen

1. **Tokens rotieren** — GitHub- und Cloudflare-Token standen einmal im Chat.
   Neue in `~/lecfantasy.env`, dann `bash worker/deploy.sh`.
2. **GitHub-Token: Recht „Actions: Read and write"** ergänzen, sonst geht der
   Admin-Knopf „Stats jetzt aktualisieren" nicht (403). Der Zeitplan läuft trotzdem.
3. **Privates Daten-Repo** (`DATA_REPO`) — siehe README. Bis dahin ist league.json
   im öffentlichen Repo lesbar.
4. **Transferfenster:** automatisch zwischen den Splits (6 h nach dem letzten Spiel
   bis 1 h vor dem ersten des nächsten; nach dem letzten Split 30 Tage). Eigene
   Fenster zusätzlich unter Admin → Einstellungen.
5. **Saison 2027** unter Admin → Einstellungen → Saison umstellen, sobald Riot sie
   anlegt; dann pro Split Pick'em öffnen (Admin → Pick'em).

## Abgesprochene Regeln (02.10.2026)

- Pick-Timer **90 s, dann Auto-Pick** (Watchlist zuerst, sonst bester Verfügbarer).
- **Trades:** nur die zwei Manager müssen zustimmen (Admin-Veto bleibt).
- **Free Agents** (ungedraftete Spieler): 1 Wechsel pro Woche (Mo–So).
- Alles nur **in Transferfenstern**, die Fabian einträgt (LEC-Regelwerk / Absprache).
- **Free Agents über Waiver**: Di + Fr 03:00 (deutsche Zeit), Tabellenletzter zuerst, 1 pro Woche.
- **Bonus** +2 für 10+ Kills oder Assists. Alles unter Admin → Einstellungen änderbar.
- Bot-Probelauf 02.10.2026 auf dem Live-System mit echtem Cron: Draft-Autostart
  (46 s nach Termin), Auto-Pick nach 30-s-Timer, Waiver-Lauf zum Slot korrekt
  (umkämpfter Spieler nach Priorität), Trade, Konsistenz 0/0. Danach aufgeräumt.
- Kaderregeln bei Transfers: Rollen bleiben besetzt **an**, Team-Limit **an** —
  Letzteres blockiert in einer vollen Liga fast jeden 1:1-Trade (im QA-Draft gab
  es keinen einzigen legalen). Bei Bedarf in den Einstellungen abschalten.

## Saison, Aufstellung, Pick'em (02.10.2026)

- Saison = alle LEC-Turniere eines Jahres (`data/season.json`), offizielle Tabelle
  + Playoffs je Split in `data/standings.json`. Gesamtwertung über alle Splits.
- **Kader 10 = 2 pro Rolle**, **wöchentliche Aufstellung**: 5 Starter punkten,
  Kapitän ×1,5, Vize übernimmt, wenn der Kapitän nicht spielt; Auto-Wechsel von der
  Bank bei gleicher Rolle; ohne Eingabe gilt die letzte Aufstellung, sonst die
  beste nach Schnitt. Sperre beim ersten Spiel der Woche.
- **Pick'em pro Split**: Fragen + Punkte wählt der Admin; Tipps liegen bis zur
  Sperre nur im KV (niemand sieht fremde), der Cron deckt auf; Auswertung nach
  Split-Ende automatisch, eigene Fragen per Admin-Antwort. Punkte zählen zur Wertung.
- **FAAB** als dritte Waiver-Reihenfolge (Budget 100, Gleichstand → schlechter
  Platzierter). Standard bleibt „Tabellenletzter zuerst".
- **LEC-Tab**: Spielplan (Filter, „meine Spieler", .ics), Tabelle, Playoffs, Teams.
  Die API liefert keine Verknüpfung der Playoff-Spiele — der Baum wird aus dem
  Weg der Teams gebaut (Niederlage oder voriges Lower-Spiel = Lower Bracket).
- Probelauf 02.10.2026 live mit 4 Bots: 10er-Draft (je 2/Rolle, Cron-Auto-Pick),
  Pick'em mit Cron-Aufdeckung 49 s nach Sperre, Auswertung gegen echte Ergebnisse,
  FAAB-Lauf, Aufstellungen über 23 Wochen (30 Auto-Wechsel, 14× Vize). Aufgeräumt.

## Liga-Extras (02.10.2026)

- **Chat** (`#/chat`): liegt im KV (`chat`, letzte 300), nicht in league.json — eine
  Chatzeile soll kein Git-Commit sein. 2 s Abstand pro Person, 500 Zeichen, eigene
  Zeilen löschen, Admin schreibt als „Admin“ und löscht alles. Push an alle außer
  Absender (abschaltbar pro Person). Ungelesen-Punkt am Übersicht-Tab (`chatLast`
  im /api/state).
- **Aufstellungs-Erinnerung**: Cron, 3 h vor der Sperre, einmal pro Woche — nur an
  Manager mit Startern, deren Team nicht spielt oder die zuletzt nicht gespielt haben.
- **Wochen-Rückblick** (`#/rueckblick`): Wochensieger, Duelle, Spieler/Flop der Woche,
  Bank-Pech, „Hatte keiner“, Saisonrekord. Push ≥ 10 h nach dem letzten Spiel der
  Woche, nur 9–22 Uhr, nie für Wochen älter als 3 Tage.
- **Ruhmeshalle** (`#/ruhmeshalle`): eingefroren 12 h nach Split-Ende, nur für Splits,
  die die Liga gespielt hat (Draft vor dem letzten Spiel). Plus Saison-Eintrag, wenn
  alle Splits drin sind. Übersteht Draft-Reset. Admin → Punkte: neu berechnen/entfernen.
- **Trade-Helfer**: beide Seiten mit Punkten, Ø pro Spiel, Form (letzte 5) und Bilanz.
- Eigene Liga-Playoffs bewusst **nicht** — bei wenigen Spielern sitzt sonst einer raus.

## Backups (02.10.2026)

- league.json: jede Änderung ist ein Git-Commit (Admin → Verlauf, Restore pro Commit).
- Zusätzlich **tägliches Backup ab 05:00** (Cron, nur wenn sich etwas geändert hat →
  praktisch eins pro Spieltag), 60 Stück, in KV `backup:<datum>`, Liste in
  `backup:index` (KV-Listings hängen bis 60 s hinterher — nie für die Liste benutzen).
  Inhalt: Liga + Chat + geheime Tipps + Ansprüche + Watchlists + Logins (Hashes).
  Downloads enthalten **keine** Logins. Restore sichert vorher den aktuellen Stand,
  stellt fehlende Logins wieder her, überschreibt nie ein neueres Passwort.
- Admin → Backups: jetzt sichern, herunterladen, wiederherstellen, Datei hochladen,
  löschen. System-Check zeigt, ob der tägliche Lauf passiert ist.

## Testmodus (02.10.2026)

- Admin → Testmodus: nur im Status Anmeldung. Start = Backup + 1–5 Bots (`league.testMode
  = { on, startedAt, backupId, bots }`) + Trades „immer offen“. Ende = Backup zurück.
- Bots (worker/src/testmode.js): picken sofort in **einem** Commit, sobald sie dran sind
  (nach jedem Pick, State-Poll, Admin-Op, Cron), aus ihren 3 besten legalen Spielern;
  tippen jeden offenen Pick'em; nehmen Trades an, wenn sie ≥ 90 % des Werts bekommen;
  antworten manchmal im Chat. Banner „Testmodus“ auf allen Seiten.
- Live probiert: Draft 4 Manager × 10 in 35 s.

## Handy

- Admin-Bereich auf 360/390 px geprüft (alle Tabs): Listen mit Knöpfen sind Blöcke statt
  Tabellen (Mitglieder, Picks, Verlauf, Backups); `select/input/textarea` nie breiter
  als ihr Platz (theme.css).

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` + `app.js` | Die Seite (Hash-Routen). Ausgeloggt nur öffentliche Daten. |
| `admin-ui.js` | Admin-Seite `#/admin`. |
| `theme.css` | Design (lolesports-Palette). |
| `scoring.js` | **Alle Regeln.** Von Seite, Admin und Worker importiert. |
| `common.js` | Öffentliche Daten laden + Anzeige-Bausteine. Wendet Stat-Korrekturen an. |
| `sw.js` | Service Worker nur für Push, cacht absichtlich nichts. |
| `worker/src/index.js` | Router, Auth-Grenze. |
| `worker/src/store.js` | **Einziger Schreibweg** (`writeLeague`): Konflikt-Retry, Validierung, GitHub-5xx-sicher. |
| `worker/src/auth.js` | Passwörter (PBKDF2), Sessions (KV, 30 Tage), Admin-Token (HMAC, ohne KV). |
| `worker/src/draft.js` | Beitreten, Picken (ein Pfad für Mitglied/Admin/Auto), Timer, Trades. |
| `worker/src/admin.js` | Alle Admin-Operationen, Health, History/Restore. |
| `worker/src/push.js` | Web Push. |
| `scripts/fetch_lolesports.py` | Stats/Teams/Spieler/Spielplan/Champions. |
| `data/league.json` | Die Liga. **Wird vom Worker geschrieben** — siehe Fallen. |
| `data/overrides.json` | Stat-Korrekturen vom Admin. |

## Entscheidungen

- **Daten von lolesports, nicht Leaguepedia** — kein Login nötig, offizielle
  Logos/Fotos, Joins per ID. Sieger aus Serienstand (53/53 verifiziert).
- **Mitgliedschaft per Einladungslink**, Login per Name. Keine festen Slots.
- **Kapazität aus dem Pool**, nicht pool/6: simuliert hängen bei 10 Managern 97 %
  der Drafts, bei 7 0 %. Regel: max. 80 % des Pools + je Rolle einer übrig. Dazu
  Lockerungsstufen, damit nie ein Draft hängt (7500 Simulationen, 0 hängen).
- **Wechsel/Trades zählen ab Datum** (Punkte davor bleiben beim alten Manager).
- **Admin-Token zustandslos** (HMAC), damit Admin auch bei KV-Problemen geht.
- **Push-Absender = Seiten-URL**, nicht die E-Mail.

## Fallen (alle schon einmal passiert)

- **Nie mit `-X ours` mergen.** Der Worker committet `data/league.json` (Picks,
  Beitritte). Lokal immer `git fetch` + normaler Merge; die GitHub-Version ist die
  Wahrheit.
- **GitHub antwortet manchmal 502**, auch wenn der Schreibvorgang durchging. Nie
  blind wiederholen (ein Undo würde zwei Picks löschen) — `writeLeague` liest nach
  und prüft. Test `github_hiccups_are_safe`.
- **Live-Feed hängt Minuten hinterher**; `startingTime` zu nah an jetzt = HTTP 400,
  ganz ohne `startingTime` = erster Frame des Spiels (0 Gold). `gameFrame` tastet
  sich zurück.
- **Vor jedem Push mit Seiten-Änderungen `python scripts/stamp.py`.** GitHub Pages
  cacht 10 min; ohne neuen `?v=` läuft beim Nutzer altes app.js gegen den neuen
  Worker (so scheiterte einmal der Admin-Login direkt nach einer Änderung).
- **Browser-Tests:** `addInitScript` läuft bei jedem neuen Dokument wieder — für
  „ausgeloggt"-Checks eine neue Seite ohne Init-Script nehmen.

## Ideen für später

- Zusätzliche Wertungen aus dem `details`-Feed (Vision, Damage-Share, KP)
