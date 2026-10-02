# LEC Fantasy

Private Fantasy-Liga für die LEC. Snake Draft, echte Stats, eigener Bereich für
jeden Manager, Admin-Backbone für jeden Notfall. Läuft komplett online und
kostenlos: **GitHub Pages** (Seite), **Cloudflare Worker** (Login, Draft, Admin),
**GitHub Action** (Stats).

**Seite:** <https://fne-stack.github.io/lecfantasy/>

## So läuft's

1. Du (Admin) öffnest **`#/admin`** → *Mitglieder* → Einladungslink kopieren und rumschicken.
2. Jeder öffnet den Link, wählt **Name + Passwort** — fertig, er ist dabei. Später
   loggt er sich mit genau diesem Namen und Passwort ein. Kein Slot-Aussuchen, kein Limit
   außer dem, was der Spielerpool hergibt (das rechnet die Seite selbst aus).
3. Du startest im Admin den Draft (*Draft → Draft läuft*), optional vorher Reihenfolge auslosen.
4. Jeder pickt selbst. Wer dran ist, bekommt den goldenen Balken, einen Ton und — wenn
   aktiviert — eine Push-Nachricht aufs Handy.
5. Danach läuft die Saison: Punkte kommen automatisch 2× täglich, live während der Spiele
   auf **Live**.

Nicht eingeloggt sieht man **nur öffentliche LEC-Infos** (Ergebnisse, Spielplan,
Profi-Stats) und den Login. Mitglieder, Kader und Picks gibt es nur nach dem Login.

## Bereiche

| | |
|---|---|
| **Übersicht** | Tabelle (Punkte oder Head-to-Head), Duelle der Woche, Top-Spieler, Ergebnisse, Spielplan |
| **Mein Team** | Aufstellung der Woche (5 Starter, Kapitän ×1,5, Vize, Auto-Wechsel), Platz, Punkte, Ø/Woche, Kader mit nächstem Spiel und Form, Punkte pro Woche, dein Duell, nächste Spiele, Push an/aus |
| **Draft** | Uhr, Pool nach Punkten, ★ Watchlist (= Auto-Pick-Reihenfolge), bester Verfügbarer pro Rolle, Draft Board |
| **Pick'em** | Saison-Tipps vor jedem Split (Fragen + Punkte vom Admin), danach Auflösung; zählt zur Wertung |
| **Transfers** | Trades mit Vergleich (Punkte, Ø, Form), Free Agents über Waiver (Reihenfolge oder FAAB-Gebote), Fenster automatisch zwischen den Splits |
| **Chat · Rückblick · Ruhmeshalle** | Liga-Chat mit Push; Wochen-Rückblick (Sieger, Spieler/Flop der Woche); Sieger jedes Splits für immer |
| **Live** | Live-Punkte während LEC-Spielen, auch pro Manager |
| **LEC** | Spielplan (Filter, „nur meine Spieler“, Kalender-Export .ics), offizielle Tabelle, Playoff-Baum, Teams — je Split |
| **Spieler** | alle Profis mit Form, Champion-Pool, Game-Log |
| **Admin** `#/admin` | eigenes Passwort, siehe unten |

## Admin — eingreifen bei jedem Fehler

Jede Admin-Aktion ist ein Commit. **Alles ist rückgängig machbar** (*Verlauf → Wiederherstellen*).

- **Draft:** Pick für jemanden setzen (optional Regeln ignorieren), Pick ändern / entfernen /
  einem anderen zuordnen, letzten Pick rückgängig, Anmeldung / läuft / gesperrt, zurücksetzen,
  Reihenfolge ändern oder auslosen, Snake, Pick-Timer (aus / Anzeige / Auto-Pick)
- **Mitglieder:** Einladungslink (neu erzeugen = alter ungültig), umbenennen, Passwort neu
  setzen, abmelden, entfernen, manuell hinzufügen
- **Punkte:** Bonus/Malus, Spielerwechsel (zählen ab Datum), Trades durchwinken/Veto
- **Stats:** Update sofort starten, Turnier setzen, einzelne Spiele korrigieren oder
  rausnehmen (bleibt auch nach jedem Update)
- **Liga:** Name, Punkte-Regeln, Kader-Regeln, Haupttabelle, Trade-Regeln
- **Prüfung:** System-Check (GitHub, KV, Daten, Stats-Job, Push) und Datenprüfung mit
  „Beheben"-Knopf
- **Rohdaten:** league.json direkt, mit Prüfung vor dem Speichern
- **Notfall:** was tun, wenn …

Schutzmechanismen, die nicht abschaltbar sind: Jede Änderung läuft über **einen** Schreibweg,
der Konflikte erkennt und kaputte Daten ablehnt. Ein GitHub-Aussetzer (502) führt nie dazu,
dass eine Aktion doppelt ausgeführt wird. Ein Draft kann nicht hängen bleiben: hat jemand
keinen regulären Pick mehr, lockert sich für diesen Pick das Team-Limit.

## Einrichtung / Zugangsdaten

Alles steht in `~/lecfantasy.env` (außerhalb des Repos, nie committen):

```
GITHUB_TOKEN=github_pat_...        Contents + Workflows (+ Actions für „Stats jetzt") read/write
CLOUDFLARE_API_TOKEN=...           Vorlage „Edit Cloudflare Workers"
CLOUDFLARE_ACCOUNT_ID=...
ADMIN_PASSWORD=...                 Admin-Login auf #/admin
VAPID_PUBLIC=... / VAPID_PRIVATE=  Push-Schlüssel
```

`bash worker/deploy.sh` setzt alle Secrets und deployt den Worker. Danach pushen.

**Echte Privatsphäre:** solange `DATA_REPO` nicht gesetzt ist, liegt `league.json` im
öffentlichen Repo (die Seite zeigt es nur nach Login, aber das Repo ist lesbar). Für privat:
Repo `lecfantasy-data` (privat) anlegen, Token darauf erweitern, in `worker/wrangler.toml`
`DATA_REPO` einkommentieren, league.json hineinkopieren, deployen.

## Daten

lolesports-API (ohne Login): Teams, Kürzel, Logos, Spieler, echte Namen, Fotos, Spielplan,
K/D/A/CS/Sieg pro Spiel, offizielle Tabellen und Playoffs. Eine Saison = alle drei Splits
eines Jahres. Sieger pro Spiel aus dem offiziellen Serienstand (Saison 2026: 186/186 Serien
korrekt; ein Spiel ohne Feed-Daten wird gemeldet statt mitgezählt). Live-Daten direkt aus dem Live-Feed (hängt dem Stream ein paar Minuten nach).

## Punkte

Kill 3 · Tod −1 · Assist 1,5 · CS 0,02 · Sieg 2, +2 bei 10+ Kills oder Assists — im Admin
änderbar. Mit Aufstellung punkten nur die 5 Starter; dazu kommen Pick'em-Punkte. `scoring.js` ist die
einzige Stelle mit Regeln; Seite, Admin und Worker benutzen dieselbe Datei.

## Tests

```bash
node scripts/test_rules.mjs     # Regeln: Lifecycle, Kapazität, Deadlock-Schutz, Trades, H2H, Prüfung
node worker/test_worker.mjs     # Worker: Einladung, Login, Draft, alle Admin-Eingriffe, Restore,
                                #   Timer, Trades, GitHub-Aussetzer, keine Geheimnisse in Antworten
python scripts/test_scoring.py  # Punkte + Snake, Python ↔ JS abgeglichen
```

Fanprojekt, keine Verbindung zu Riot Games oder der LEC.
