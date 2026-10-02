# Projekt-Notizen / Handoff

Stand: **2. Oktober 2026**. Für die Fortsetzung mit Claude Code: Stand, offene
Punkte, Entscheidungen und Fallen, in die man schon getreten ist.

## Stand

**LIVE, leer, bereit.** Liga im Status *Anmeldung*, 0 Mitglieder, frischer
Einladungslink im Admin. Alle Tests grün (Regeln 10/10, Worker 13/13, Punkte 4/4).
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
4. **Transferfenster eintragen** (Admin → Einstellungen → Transferfenster), sobald
   das LEC-Regelwerk 2027 die Zeiträume nennt. Ohne Fenster sind Transfers zu.

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

- Spieltags-Ansicht, Lineups pro Spieltag, Trades-UI (nach Regel-Entscheidung)
- Zusätzliche Wertungen aus dem `details`-Feed (Vision, Damage-Share, KP)
