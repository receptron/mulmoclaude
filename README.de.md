# MulmoClaude

[![npm version](https://img.shields.io/npm/v/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![npm downloads](https://img.shields.io/npm/dm/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![License: MIT](https://img.shields.io/npm/l/mulmoclaude.svg)](LICENSE)
[![CI](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml/badge.svg)](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml)
[![GitHub stars](https://img.shields.io/github/stars/receptron/mulmoclaude.svg?style=social)](https://github.com/receptron/mulmoclaude/stargazers)

[English](README.md) · [日本語](README.ja.md) · [简体中文](README.zh.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português (BR)](README.pt-BR.md) · [Français](README.fr.md) · **Deutsch**

**Einen KI-Assistenten, der alles über Sie weiß und Ihnen rund um die Uhr zur Seite steht, gibt es nirgendwo zu kaufen. Sie können keinen kaufen — Sie können nur einen großziehen. MulmoClaude ist ein Werkzeug, um Ihren eigenen KI-Assistenten großzuziehen — auf Ihrem eigenen Computer.**

Die Substanz eines Assistenten ist nicht das KI-Modell — das Modell ist nur der Motor. Was einen Assistenten wertvoll macht, ist, wie viel er über Sie weiß: Ihre Gespräche, Ihren Kalender, Ihre Notizen, Ihre Daten und die Anwendungen, die Sie nutzen. Etwas so Wichtiges sollte keinem einzelnen Dienstanbieter anvertraut werden — je länger Sie ihn nutzen, desto schwerer wird der Abschied. MulmoClaude ist Open Source und läuft lokal, sodass alles, was Ihr Assistent ansammelt — Erinnerungen, Daten, Anwendungen — in Ihren eigenen Händen bleibt, als einfache Dateien in Ihrem Workspace.

Großziehen braucht eine Umgebung, und MulmoClaude stellt sie bereit: einen Ort, um Erinnerungen anzusammeln (ein persönliches Wiki, das Claude selbst aufbaut und pflegt), einen Ort für Ihre Daten (schemagesteuerte Collections, Feeds, einfache Dateien) und einen Ort, um Anwendungen nur für Sie zu bauen — ganz ohne Programmierkenntnisse. Sie sagen in Alltagssprache „ich hätte gern so etwas“, und Claude baut die kleine Anwendung, die Sie brauchen: eine Restaurantliste, einen Rechnungs-Tracker, Vokabeltraining — Software für ein Publikum von einer Person. Direkt nach der Installation ist der Garten noch leer; Sie säen Samen, pflegen den Boden und ziehen einen Assistenten groß, der nur Ihnen gehört.

Und der Assistent ist nicht an Ihren Schreibtisch gebunden. Melden Sie sich vom Telefon an — oder über eine Messaging-App, die Sie bereits nutzen — und Sie erreichen denselben Assistenten, der auf Ihrem Computer lebt. Der Relay-Server befördert nur Nachrichten auf ihrem Weg — Ihre Erinnerungen, Daten und Anwendungen verlassen niemals Ihren Computer.

Unter der Haube ist MulmoClaude eine KI-native Anwendungsplattform: Fähigkeiten sind Plugins in einem einzigen Register (heute: ein vollständiges Buchhaltungssystem mit echter serverseitiger Buchführungslogik, ein persönliches Wiki, ein SEC-Filings-Reader und mehr), Claude fungiert als universeller Controller, der über sie hinweg komponiert, und der Chat ruft die passende GUI für jede Aufgabe auf — Markdown, Diagramme, Formulare, Wikis, Tabellenkalkulationen oder 3D-Szenen.

> **[How AI-Native Applications Should Be Built](MANIFEST.md)** — die Architektur-, UX- und Protokollthese hinter MulmoClaude.

## 📣 Neuigkeiten

Neue Releases und Funktionen werden **auf Japanisch** auf X angekündigt.

- [Singularity Society (@SingularitySoci)](https://x.com/SingularitySoci) — Ankündigungen zu Releases und neuen Funktionen
- [Satoshi Nakajima (@snakajima)](https://x.com/snakajima) — Eigentümer von MulmoClaude

## Schnellstart

```bash
npx mulmoclaude@latest
```

Der Launcher startet den Server und öffnet [http://localhost:3001](http://localhost:3001) in Ihrem Browser. Das war's — beginnen Sie mit dem Chat.

> **Im Hintergrund weiterlaufen lassen**: Beim Schließen des Terminals stoppt der Server. Für den Dauerbetrieb starten Sie ihn in `tmux` / `screen` (macOS/Linux) oder als Startaufgabe in der Windows-Aufgabenplanung.

### Voraussetzungen

- **Node.js 22.19+** — Laufzeitumgebung
- **[Claude Code CLI](https://claude.ai/code)** — installiert und authentifiziert. Führen Sie `claude` einmal aus, um das OAuth abzuschließen
- **ffmpeg** — für die Videogenerierung erforderlich. Kann übersprungen werden, wenn Sie keine Videos erzeugen
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg`
- **Docker Desktop** (optional, aber empfohlen) — aktiviert den Sandbox-Modus. Siehe [Docker Desktop installieren](#docker-desktop-installieren) unten

> **UI-Sprache**: 8 Sprachen werden unterstützt (Englisch, Japanisch, Chinesisch, Koreanisch, Spanisch, Portugiesisch (BR), Französisch, Deutsch). Standardmäßig wird die Sprache automatisch aus der Browser- / Betriebssystemsprache erkannt. Um sie explizit festzulegen, setzen Sie `VITE_LOCALE=de` in `.env`. Die Locale wird zur Build-/Dev-Zeit ausgewählt; starten Sie `yarn dev` nach einer Änderung neu. Siehe [`docs/developer.md`](docs/developer.md#i18n-vue-i18n) zum Hinzufügen von Strings.

### Vom Quellcode aus ausführen (für Entwickler)

Wenn Sie den Code ändern statt ihn nur auszuführen möchten:

```bash
git clone git@github.com:receptron/mulmoclaude.git
cd mulmoclaude && yarn install
cp .env.example .env   # optional — fügen Sie GEMINI_API_KEY für die Bilderzeugung hinzu
yarn dev
```

Öffnen Sie [http://localhost:5173](http://localhost:5173). Architektur und Skripte siehe [`docs/developer.md`](docs/developer.md).

> **UI wirkt kaputt oder ungestylt?** Icons als Wörter, `dist/*` mit 404, `401` nach einem Neustart — siehe [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Was kann man tun?

| Bitten Sie Claude um...                                   | Was Sie erhalten                                      |
| --------------------------------------------------------- | ----------------------------------------------------- |
| „Schreibe einen Projektvorschlag"                         | Umfangreiches Markdown-Dokument im Canvas             |
| „Stelle den Umsatz des letzten Quartals als Diagramm dar" | Interaktive ECharts-Visualisierung                    |
| „Erstelle einen Reiseplan für Kyoto"                      | Illustrierter Reiseführer mit Bildern                 |
| „Richte eine Todo-Liste ein“                              | Schema-gesteuerte Collection mit Kanban-Board         |
| „Nimm diesen Artikel auf: URL"                            | Wiki-Seite mit `[[links]]` für das Langzeitgedächtnis |
| „Plane eine tägliche Nachrichtenübersicht"                | Wiederkehrende Aufgabe, die automatisch läuft         |
| „Erzeuge ein Bild eines Sonnenuntergangs"                 | KI-generiertes Bild (Gemini)                          |
| „Abonniere diesen RSS-Feed"                               | Daten-Feed unter `/feeds`, geplante Abrufe            |
| „Was gibt es Neues in meinen Feeds?"                      | Feed-Einträge gesammelt unter `/feeds`                |

> **Direkt erreichbare Seiten**: `/wiki` (Durchsuchen + Lint), `/feeds` (Daten-Feeds), `/collections` (Daten-Apps), `/automations` (wiederkehrende Aufgaben), `/files`, `/skills`, `/roles`. Jede Seite hat einen eigenen Chat-Composer, der einen neuen Chat startet, der den Seitenkontext bereits kennt.

> **Sie arbeiten an MulmoClaude?** Siehe [`docs/developer.md`](docs/developer.md) für Umgebungsvariablen, Skripte und Architektur.

### Messaging-Bridges

Auf MulmoClaude kann über **Bridge-Prozesse** aus Messaging-Apps zugegriffen werden. Bridges laufen als separate Kindprozesse und verbinden sich über socket.io mit dem Server.

```bash
# Interactive CLI bridge (same machine)
yarn cli

# Telegram bot bridge (requires TELEGRAM_BOT_TOKEN in .env)
yarn telegram
```

Bridges sind auch als eigenständige npm-Pakete verfügbar:

```bash
# Chat platforms
npx @mulmobridge/cli@latest          # CLI bridge
npx @mulmobridge/telegram@latest     # Telegram bridge
npx @mulmobridge/slack@latest        # Slack bridge
npx @mulmobridge/discord@latest      # Discord bridge
npx @mulmobridge/line@latest         # LINE bridge
npx @mulmobridge/whatsapp@latest     # WhatsApp bridge
npx @mulmobridge/matrix@latest       # Matrix bridge
npx @mulmobridge/irc@latest          # IRC bridge
npx @mulmobridge/mattermost@latest   # Mattermost bridge
npx @mulmobridge/zulip@latest        # Zulip bridge
npx @mulmobridge/messenger@latest    # Facebook Messenger bridge
npx @mulmobridge/google-chat@latest  # Google Chat bridge
npx @mulmobridge/mastodon@latest     # Mastodon bridge
npx @mulmobridge/bluesky@latest      # Bluesky bridge
npx @mulmobridge/chatwork@latest     # Chatwork bridge (Japanese business chat)
npx @mulmobridge/xmpp@latest         # XMPP / Jabber bridge
npx @mulmobridge/rocketchat@latest   # Rocket.Chat bridge
npx @mulmobridge/signal@latest       # Signal bridge (via signal-cli-rest-api)
npx @mulmobridge/teams@latest        # Microsoft Teams bridge (Bot Framework)
npx @mulmobridge/line-works@latest   # LINE Works bridge (enterprise LINE)
npx @mulmobridge/nostr@latest        # Nostr encrypted DM bridge
npx @mulmobridge/viber@latest        # Viber bridge

# Universal / glue
npx @mulmobridge/webhook@latest      # Generic HTTP webhook (dev glue)
npx @mulmobridge/twilio-sms@latest   # SMS via Twilio
npx @mulmobridge/email@latest        # Email bridge (IMAP + SMTP)
```

Alle Bridges unterstützen **Text-Streaming in Echtzeit** (Tipp-Aktualisierungen während der Agent schreibt). CLI und Telegram unterstützen außerdem **Dateianhänge** (Bilder, PDFs, DOCX, XLSX, PPTX). Siehe [`docs/mulmobridge-guide.md`](docs/mulmobridge-guide.md) für die vollständige Plattformliste und Einrichtungsanweisungen.

### Warum brauchen Sie einen Gemini API-Schlüssel?

MulmoClaude verwendet Googles **Gemini 3.1 Flash Image (nano banana 2)**-Modell für Bildgenerierung und -bearbeitung. Dies ermöglicht:

- `generateImage` — erstellt Bilder aus Textbeschreibungen
- `editImage` — transformiert oder modifiziert ein bestehendes Bild (z. B. „in den Ghibli-Stil umwandeln")
- Eingebettete Bilder in Dokumenten (Recipe Guide, Trip Planner usw.)

Ohne einen Gemini API-Schlüssel werden Rollen, die Bildgenerierung verwenden, in der Benutzeroberfläche deaktiviert.

### Einen Gemini API-Schlüssel erhalten

1. Gehen Sie zu [Google AI Studio](https://aistudio.google.com/apikey)
2. Melden Sie sich mit Ihrem Google-Konto an
3. Klicken Sie auf **API-Schlüssel erstellen**
4. Kopieren Sie den Schlüssel und fügen Sie ihn in Ihre `.env`-Datei als `GEMINI_API_KEY=...` ein

Die Gemini-API hat einen kostenlosen Tarif, der für den persönlichen Gebrauch ausreichend ist.

## Sicherheit

MulmoClaude verwendet Claude Code als KI-Backend, das Zugriff auf Werkzeuge einschließlich Bash hat — das heißt, es kann Dateien auf Ihrem Computer lesen und schreiben.

**Ohne Docker** kann Claude auf alle Dateien zugreifen, die Ihr Benutzerkonto erreichen kann, einschließlich SSH-Schlüssel und Anmeldeinformationen, die außerhalb Ihres Workspace gespeichert sind. Dies ist für die persönliche lokale Nutzung akzeptabel, aber es ist gut, dies zu verstehen.

**Mit installiertem Docker Desktop** führt MulmoClaude Claude automatisch in einem Sandbox-Container aus. Nur Ihr Workspace und Claudes eigene Konfiguration (`~/.claude`) werden eingebunden — der Rest Ihres Dateisystems bleibt für Claude unsichtbar. Keine Konfiguration erforderlich: Die App erkennt Docker beim Start und aktiviert die Sandbox automatisch.

**Bearer-Token-Authentifizierung**: Jeder `/api/*`-Endpunkt erfordert einen `Authorization: Bearer <token>`-Header. Das Token wird beim Serverstart automatisch generiert und über ein `<meta>`-Tag in den Browser eingefügt — keine manuelle Einrichtung. Die einzige Ausnahme ist `/api/files/*` (ausgenommen, weil `<img>`-Tags in gerenderten Dokumenten keine Header anhängen können). Siehe [`docs/developer.md`](docs/developer.md#auth-bearer-token-on-api) für Details.

**Sandbox-Weiterleitung von Anmeldeinformationen** (Opt-in): Standardmäßig hat die Sandbox keinen Zugriff auf Host-Anmeldeinformationen. Zwei Umgebungsvariablen ermöglichen es, das, was `git` / `gh` benötigen, selektiv freizugeben:

- `SANDBOX_SSH_AGENT_FORWARD=1` — leitet den SSH-Agent-Socket des Hosts weiter. Private Schlüssel bleiben auf dem Host.
- `SANDBOX_MOUNT_CONFIGS=gh,gitconfig` — bindet `~/.config/gh` und `~/.gitconfig` schreibgeschützt ein.

Vollständiger Kontrakt und Sicherheitshinweise: [`docs/sandbox-credentials.md`](docs/sandbox-credentials.md).

### Docker Desktop installieren

1. Laden Sie Docker Desktop von [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) herunter
2. **macOS**: Öffnen Sie die `.dmg`-Datei und ziehen Sie Docker in den Programme-Ordner, dann starten Sie es aus den Programmen
3. **Windows**: Führen Sie den Installer aus und folgen Sie den Anweisungen (WSL2 wird bei Bedarf automatisch eingerichtet)
4. **Linux**: Folgen Sie der [Linux-Installationsanleitung](https://docs.docker.com/desktop/install/linux/)
5. Warten Sie, bis Docker Desktop vollständig gestartet ist — das Walsymbol in der Menüleiste / Taskleiste sollte dauerhaft (nicht animiert) angezeigt werden
6. Starten Sie MulmoClaude neu — es erkennt Docker und baut beim ersten Start das Sandbox-Image (einmalig, dauert etwa eine Minute)

Wenn die Docker-Sandbox auf macOS aktiv ist, werden Anmeldeinformationen automatisch verwaltet — die App extrahiert OAuth-Tokens beim Start aus der System-Keychain und aktualisiert sie bei 401-Fehlern, sodass keine manuellen Schritte erforderlich sind.

Wenn Docker nicht installiert ist, zeigt die App einen Warnhinweis an und funktioniert weiterhin ohne Sandboxing.

> **Debug-Modus**: Um auch bei installiertem Docker ohne Sandbox zu laufen, setzen Sie `DISABLE_SANDBOX=1` vor dem Start des Servers, oder übergeben Sie das CLI-Flag `--disable-sandbox` (`yarn dev --disable-sandbox` / `npx mulmoclaude --disable-sandbox`; funktioniert unter Windows PowerShell).
>
> **Tool-Call-Historie**: Setzen Sie `PERSIST_TOOL_CALLS=1`, damit `tool_call`-Ereignisse (inklusive `args`) zusätzlich zu `tool_result` im Sitzungs-jsonl protokolliert werden. Standardmäßig aus, weil `args` sehr groß werden und Payload-Bytes (Base64-Bilder, MulmoScript-JSON) enthalten können, die Sie nicht auf der Festplatte erwarten würden; nützlich zum Debuggen nach einem Seitenrefresh oder Server-Neustart. Siehe [Issue #1096](https://github.com/receptron/mulmoclaude/issues/1096).

## Logging

Der Server schreibt lesbaren Text in die Konsole und vollständiges JSON
in rotierende tägliche Dateien unter `server/system/logs/`. Alles ist
über `LOG_LEVEL`, `LOG_*_FORMAT`, `LOG_FILE_DIR` usw. konfigurierbar.

Siehe [docs/logging.md](docs/logging.md) für die vollständige Referenz, Formatbeispiele,
Rotationsverhalten und Rezepte.

## Rollen

Jede Rolle gibt Claude eine andere Persona, eine andere Werkzeugauswahl und einen anderen Fokus:

| Rolle               | Was sie tut                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| **General**         | Allzweck-Assistent — Todos, Scheduler, Wiki, Dokumente, Mindmaps           |
| **Office**          | Dokumente, Tabellen, Formulare, Präsentationen, Daten-Dashboards           |
| **Guide & Planner** | Reiseführer, Rezeptbücher, Reiseplaner mit reichhaltiger visueller Ausgabe |
| **Artist**          | Bildgenerierung, Bildbearbeitung, generative Kunst mit p5.js               |
| **Tutor**           | Adaptives Lehren — bewertet Ihr Niveau, bevor etwas erklärt wird           |
| **Storyteller**     | Interaktive illustrierte Geschichten mit Bildern und HTML-Szenen           |

Das Wechseln der Rolle setzt Claudes Kontext zurück und tauscht nur die Werkzeuge aus, die diese Rolle benötigt — so bleiben die Antworten schnell und fokussiert.

## Skills — Claude Code Skills aus MulmoClaude ausführen

MulmoClaude kann die **Claude Code Skills**, die Sie bereits haben, auflisten und starten. Ein Skill ist ein beliebiger Ordner unter `~/.claude/skills/<name>/`, der eine `SKILL.md`-Datei mit einer YAML-Frontmatter-`description` und einem Markdown-Text mit Anweisungen enthält. Siehe die [Claude Code Skills-Dokumentation](https://docs.claude.com/en/docs/claude-code/skills) für Details zum Erstellen von Skills.

### Verwendung

1. Öffnen Sie MulmoClaude und bleiben Sie in einer der Skill-fähigen Rollen: **General**, **Office** oder **Tutor**.
2. Bitten Sie Claude, Ihre Skills anzuzeigen — z. B. _„zeige meine Skills"_ oder _„liste Skills auf"_.
3. Claude ruft das `manageSkills`-Tool auf, und eine geteilte **Skills**-Ansicht öffnet sich im Canvas:
   - **Links**: jeder auf Ihrem Rechner gefundene Skill mit Beschreibung und Scope-Badge (`USER` / `PROJECT`).
   - **Rechts**: der vollständige `SKILL.md`-Inhalt des ausgewählten Skills.
4. Klicken Sie auf **Run** bei einem Skill. MulmoClaude sendet `/<skill-name>` als reguläre Chat-Nachricht an Claude; der Slash-Command-Mechanismus von Claude Code löst es gegen `~/.claude/skills/` auf und führt die Anweisungen des Skills inline in derselben Chat-Sitzung aus.

Kein zusätzliches Tippen, kein Kopieren und Einfügen von SKILL.md-Inhalten — die Run-Schaltfläche ist ein Ein-Klick-Wrapper um `/skill-name`.

### Skill-Erkennung — zwei Scopes

| Scope       | Ort                                    | Semantik                                                                                                          |
| ----------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **User**    | `~/.claude/skills/<name>/SKILL.md`     | Persönliche Skills, die über jedes Projekt hinweg geteilt werden, das Sie mit der Claude CLI öffnen.              |
| **Project** | `~/mulmoclaude/.claude/skills/<name>/` | Auf den MulmoClaude-Workspace begrenzte Skills. Der Project-Scope **gewinnt**, wenn ein Name mit User kollidiert. |

Beide Scopes sind in Phase 0 schreibgeschützt — Änderungen erfolgen im Dateisystem. Ein zukünftiges Release wird es MulmoClaude selbst erlauben, Project-Scope-Skills zu erstellen / bearbeiten.

### Docker-Sandbox vs. Nicht-Docker

Der Standard-**Docker-Sandbox-Modus** von MulmoClaude isoliert Claude Code aus Sicherheitsgründen in einem Container (siehe [Sicherheit](#sicherheit)). Das Skill-Verhalten unterscheidet sich zwischen den beiden Modi:

| Modus                                  | User-Skills (`~/.claude/skills/`) | Project-Skills (`~/mulmoclaude/.claude/skills/`) | Eingebaute CLI-Skills (`/simplify`, `/update-config`, …) |
| -------------------------------------- | --------------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| **Nicht-Docker** (`DISABLE_SANDBOX=1`) | ✅ Alle funktionieren             | ✅                                               | ✅                                                       |
| **Docker-Sandbox** (Standard)          | ⚠️ Siehe Vorbehalte unten         | ✅ Eingebunden über Workspace-Volume             | ✅                                                       |

**Docker-Vorbehalte — warum User-Skills manchmal in der Sandbox nicht funktionieren:**

- **Symlinked `~/.claude/skills/`** — wenn Ihr `~/.claude/skills` (oder ein Untereintrag) ein Symlink ist, der außerhalb von `~/.claude/` zeigt (zum Beispiel `~/.claude/skills → ~/ss/dotfiles/claude/skills`), ist das Ziel des Symlinks innerhalb des Containers nicht vorhanden. Der Link erscheint als **hängend**, und Claude Code fällt auf die eingebauten Skills zurück.
- **Ältere Claude CLI im Sandbox-Image** — `Dockerfile.sandbox` fixiert die CLI-Version zum Zeitpunkt des Image-Builds. Wenn diese Version hinter Ihrer Host-CLI zurückliegt (z. B. 2.1.96 im Image vs. 2.1.105 auf dem Host), kann sich die User-Skill-Erkennung anders verhalten.

**Workarounds für Skill-reiche Setups, die nicht gut mit der Sandbox zusammenspielen:**

1. **Deaktivieren Sie die Sandbox für diese Sitzung**:

   ```bash
   # env-var form (any shell supporting VAR=value)
   DISABLE_SANDBOX=1 yarn dev

   # or the equivalent --disable-sandbox CLI flag (Windows PowerShell / npx / IDE run configs)
   yarn dev --disable-sandbox
   npx mulmoclaude --disable-sandbox
   ```

   Die Claude CLI läuft mit Ihrem echten `~/.claude/` und alles wird nativ aufgelöst. Nutzen Sie dies, wenn Sie den Prompts vertrauen, die Sie senden werden — die Sandbox bleibt der empfohlene Standard für nicht vertrauenswürdige / exploratorische Arbeit.

2. **Verschieben Sie Skills in den Project-Scope** — kopieren Sie die spezifischen Skills, die Sie wollen, nach `~/mulmoclaude/.claude/skills/` (dieser Pfad wird als Workspace-Volume innerhalb der Sandbox eingebunden, also keine Symlink-Probleme). Ideal für Skills, die ohnehin speziell für Ihren MulmoClaude-Workflow sind.

3. **Symlinks abflachen** — wenn Sie Ihre Skill-Bibliothek über Symlinks pflegen (z. B. in einem Dotfiles-Repo), ist das Ersetzen des obersten `~/.claude/skills`-Symlinks durch das echte Verzeichnis die einfachste Lösung.

### Was der Skill tatsächlich empfängt

Wenn Sie **Run** drücken, sendet MulmoClaude einen einfachen User-Turn, der den Slash-Command-String enthält:

```text
/my-skill-name
```

Das ist die gesamte Nutzlast — MulmoClaude fügt den `SKILL.md`-Inhalt oder zusätzlichen Kontext **nicht** inline ein. Den Inhalt liest Claude Code, wenn die CLI den Slash-Befehl auf ihrer Seite auflöst. Das hält die Chat-Eingabe klein und macht lange Skills (mehrere Kilobyte große `SKILL.md`) sicher ausführbar, ohne den Prompt-Kontext zu sprengen.

### Ein Gespräch als neuen Skill speichern

Nach einem produktiven Chat können Sie MulmoClaude bitten, den Workflow festzuhalten:

```text
"この会話を fix-ci という skill にして"
"save this as a skill called publish-flow"
"skill 化して"   ← Claude picks a slug for you
```

Claude liest das aktuelle Chat-Transkript, destilliert die von Ihnen ausgeführten Schritte und schreibt eine neue `SKILL.md` nach `~/mulmoclaude/.claude/skills/<slug>/`. Der Skill erscheint sofort in der Skills-Ansicht und kann in jeder zukünftigen Sitzung über `/<slug>` aufgerufen werden.

Hinweise zum Speichern:

- **Nur Project-Scope** — Speicherungen gehen nach `~/mulmoclaude/.claude/skills/`, niemals nach `~/.claude/skills/`. Der User-Scope bleibt für MulmoClaude schreibgeschützt.
- **Kein Überschreiben** — wenn bereits ein Skill mit demselben Namen existiert (in einem der beiden Scopes), schlägt das Speichern fehl und Claude fragt Sie nach einem anderen Namen.
- **Slug-Regeln** — Kleinbuchstaben, Ziffern und Bindestriche; 1–64 Zeichen; keine führenden / nachfolgenden oder aufeinanderfolgenden Bindestriche. Claude wählt automatisch einen; wenn Sie einen bestimmten Namen wünschen, erwähnen Sie ihn in der Anfrage.

### Einen gespeicherten Skill löschen

Project-Scope-Skills erhalten in der Skills-Ansicht eine **Delete**-Schaltfläche neben der Run-Schaltfläche (User-Scope-Skills sind schreibgeschützt — es wird keine Delete-Schaltfläche angezeigt). Die Bestätigung des Dialogs entfernt `~/mulmoclaude/.claude/skills/<slug>/SKILL.md`. Wenn Sie auch zusätzliche Dateien per Hand in diesem Ordner abgelegt haben, bleiben diese erhalten; nur die SKILL.md wird entfernt.

Sie können Claude auch bitten, nach Namen zu löschen:

```text
"delete the fix-ci skill"
```

## Wiki — Langzeitgedächtnis für Claude Code

MulmoClaude enthält eine **persönliche Wissensbasis**, inspiriert von [Andrej Karpathys Idee der LLM-Wissensdatenbanken](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Sie gibt Claude Code ein echtes Langzeitgedächtnis — nicht nur eine kurze `memory.md`, sondern ein wachsendes, vernetztes Wiki, das Claude selbst aufbaut und pflegt.

Die **General**-Rolle hat eine eingebaute Wiki-Unterstützung. Versuchen Sie:

- `"Ingest this article: <URL>"` — Claude ruft die Seite ab, extrahiert wichtiges Wissen, erstellt oder aktualisiert Wiki-Seiten und protokolliert die Aktivität
- `"What does my wiki say about transformers?"` — Claude durchsucht den Index, liest relevante Seiten und synthetisiert eine fundierte Antwort
- `"Lint my wiki"` — Gesundheitsprüfung für verwaiste Seiten, defekte Links und fehlende Indexeinträge
- `"Show me the wiki index"` — rendert den vollständigen Seitenkatalog im Canvas

### Wie es funktioniert

Das Wiki lebt vollständig als einfache Markdown-Dateien in Ihrem Workspace:

```
<workspace>/data/wiki/
  index.md          ← catalog of all pages (title, description, last updated)
  log.md            ← append-only activity log
  pages/<slug>.md   ← one page per entity, concept, or theme
  sources/<slug>.md ← raw ingested sources
```

Claude verwendet seine eingebauten Datei-Werkzeuge (`read`, `write`, `glob`, `grep`), um das Wiki zu navigieren und zu pflegen — keine spezielle Datenbank oder Indexierung erforderlich. Querverweise verwenden die `[[wiki link]]`-Syntax, die die Canvas-UI als klickbare Navigation rendert.

Mit der Zeit wächst das Wiki zu einer persönlichen Wissensbasis, die jede Rolle konsultieren kann, wodurch Claude mit jedem Einsatz zunehmend nützlicher wird.

## Diagramme (ECharts)

Das `presentChart`-Plugin rendert [Apache ECharts](https://echarts.apache.org/)-Visualisierungen im Canvas. Fragen Sie nach einer Linie, einem Balken, einem Kerzendiagramm, Sankey, Heatmap oder Netzwerk/Graph — Claude schreibt ein ECharts-Options-Objekt, das Plugin montiert es. Jedes Diagramm hat eine **[↓ PNG]**-Schaltfläche für den Ein-Klick-Export.

Verfügbar in den Rollen **General**, **Office**, **Guide & Planner** und **Tutor**. Versuchen Sie:

```text
Chart last quarter's revenue by region as a bar chart
Plot AAPL's daily closes for the last 30 days as a candlestick
Show a sankey of energy flow: coal/gas/solar → electricity → home/industry/transport
```

### Speicherung

Jeder `presentChart`-Aufruf schreibt eine Datei unter `<workspace>/artifacts/charts/`:

```text
<workspace>/artifacts/charts/
  sales-overview-1776135210389.chart.json
  apple-stock-1776135300000.chart.json
```

Ein einzelnes Dokument kann beliebig viele Diagramme enthalten, die gestapelt im Canvas gerendert werden:

```json
{
  "title": "Apple Stock Analysis",
  "charts": [
    {
      "title": "Daily close",
      "type": "line",
      "option": {
        "xAxis": {
          "type": "category",
          "data": ["2024-01", "2024-02", "2024-03"]
        },
        "yAxis": { "type": "value" },
        "series": [{ "type": "line", "data": [180, 195, 210] }]
      }
    },
    {
      "title": "Volume",
      "type": "bar",
      "option": {
        "xAxis": {
          "type": "category",
          "data": ["2024-01", "2024-02", "2024-03"]
        },
        "yAxis": { "type": "value" },
        "series": [{ "type": "bar", "data": [1000000, 1200000, 950000] }]
      }
    }
  ]
}
```

Das `option`-Feld wird unverändert an ECharts' [`setOption`](https://echarts.apache.org/en/api.html#echartsInstance.setOption) übergeben — Sie können die vollständige [ECharts-Options-Referenz](https://echarts.apache.org/en/option.html) beim manuellen Bearbeiten dieser Dateien heranziehen. Änderungen werden beim nächsten Öffnen des Dokuments im Canvas reflektiert.

## Optional: X (Twitter) MCP-Tools

MulmoClaude enthält optionale MCP-Tools zum Lesen und Suchen von Posts auf X (Twitter) über die offizielle X API v2.

| Tool        | Was es tut                                          |
| ----------- | --------------------------------------------------- |
| `readXPost` | Ruft einen einzelnen Post über URL oder Tweet-ID ab |
| `searchX`   | Sucht aktuelle Posts nach Stichwort oder Anfrage    |

Diese Tools sind **standardmäßig deaktiviert** und benötigen ein X API Bearer Token zur Aktivierung.

### Einrichtung

1. Gehen Sie zu [console.x.com](https://console.x.com) und melden Sie sich mit Ihrem X-Konto an
2. Erstellen Sie eine neue App — ein Bearer Token wird automatisch generiert
3. Kopieren Sie das Bearer Token und fügen Sie es in Ihre `.env` ein:
   ```
   X_BEARER_TOKEN=your_bearer_token_here
   ```
4. Fügen Sie Credits zu Ihrem Konto bei [console.x.com](https://console.x.com) hinzu (erforderlich für API-Aufrufe)
5. Starten Sie den Dev-Server neu — die Tools aktivieren sich automatisch

### Verwendung

Diese Tools sind **nur in benutzerdefinierten Rollen verfügbar**. Die eingebauten Rollen enthalten sie standardmäßig nicht (außer General). Um sie in Ihrer eigenen Rolle zu verwenden:

1. Erstellen oder bearbeiten Sie eine benutzerdefinierte Rollen-JSON-Datei unter `~/mulmoclaude/roles/<id>.json`
2. Fügen Sie `readXPost` und/oder `searchX` zu ihrer `availablePlugins`-Liste hinzu

Einmal konfiguriert, können Sie jede `x.com`- oder `twitter.com`-URL in den Chat einfügen und Claude ruft sie automatisch ab und liest sie.

## Zusätzliche Tools konfigurieren (Web-Einstellungen)

Das Zahnradsymbol in der Seitenleiste öffnet ein Einstellungs-Modal, in dem Sie Claudes Toolset ohne Code-Änderungen erweitern können. Änderungen werden bei der nächsten Nachricht wirksam (kein Serverneustart erforderlich).

### Tab „Allowed Tools"

Fügen Sie Tool-Namen zeilenweise ein. Nützlich für die eingebauten MCP-Server von Claude Code (Gmail, Google Calendar) nach einem einmaligen OAuth-Handshake:

```text
mcp__claude_ai_Gmail
mcp__claude_ai_Google_Calendar
```

Führen Sie zunächst einmal `claude mcp` in einem Terminal aus und durchlaufen Sie den OAuth-Flow für jeden Dienst — die Anmeldeinformationen werden unter `~/.claude/` gespeichert.

### Tab „MCP Servers"

Fügen Sie externe MCP-Server ohne manuelles JSON-Editieren hinzu. Zwei Typen werden unterstützt:

- **HTTP** — Remote-Server (z. B. `https://example.com/mcp`). Funktioniert in jedem Modus; in Docker werden `localhost` / `127.0.0.1`-URLs automatisch auf `host.docker.internal` umgeschrieben.
- **Stdio** — lokaler Subprozess (z. B. ein `npx`-MCP), aus Sicherheitsgründen auf `npx` / `node` / `tsx` beschränkt. Läuft auf dem Host, wenn die Docker-Sandbox **aus** ist. Ist die Sandbox **an**, werden Stdio-Einträge **standardmäßig verworfen** (das minimale Sandbox-Image kann keine beliebigen Laufzeiten hosten) — mit `"hostExecInDocker": true` läuft ein solcher Server stattdessen auf dem Host hinter einem `stdio ↔ HTTP`-Gateway. Siehe [docs/mcp-sandbox.md](docs/mcp-sandbox.md).

Übergib Anmeldedaten an einen Stdio-Server mit einer **`env`**-Map (`"env": { "IMAP_PASS": "…" }`). Werte sind wörtlich und werden in `mcp.json` gespeichert (Modus `0600`, aber **im Klartext** — Schutz per Dateiberechtigung, kein Tresor). Alle Details, einschließlich des `hostExecInDocker`-Opt-ins und wie `env` den Prozess erreicht, stehen in [docs/mcp-sandbox.md](docs/mcp-sandbox.md).

Die Konfiguration befindet sich unter `<workspace>/config/`:

```text
<workspace>/config/
  settings.json    ← extra allowed tool names
  mcp.json         ← Claude CLI --mcp-config compatible
```

Die MCP-Datei verwendet das Standardformat der Claude CLI, damit Sie sie zwischen Rechnern kopieren oder sogar direkt mit der `claude`-CLI verwenden können.

### Direktes Bearbeiten der Konfigurationsdateien

Beide Dateien sind einfaches JSON — Sie können sie mit jedem Texteditor anstelle der Einstellungs-UI bearbeiten. Der Server liest sie bei jeder Nachricht neu ein, also:

- Kein Serverneustart nach einer Dateibearbeitung erforderlich.
- Änderungen werden auch von der Einstellungs-UI übernommen — einfach das Modal schließen und wieder öffnen.
- Die UI und die Datei sind immer synchron: Das Speichern aus der UI überschreibt die Datei, und Handbearbeitungen erscheinen beim nächsten Öffnen in der UI.

Dies ist praktisch für:

- Massenimport von MCP-Servern von einer anderen Arbeitsstation (kopieren Sie `mcp.json` herüber).
- Versionskontrolle Ihrer Einrichtung in einem Dotfiles-Repo.
- Temporäres Auskommentieren eines Servers durch Umschalten auf `"enabled": false`.

**Beispiel-`mcp.json`** — ein remoter HTTP-Server (öffentlich, keine Authentifizierung) und ein lokaler Stdio-Server:

```json
{
  "mcpServers": {
    "deepwiki": {
      "type": "http",
      "url": "https://mcp.deepwiki.com/mcp",
      "enabled": true
    },
    "everything": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "enabled": true
    }
  }
}
```

Einschränkungen, die der Server beim Laden der Datei durchsetzt:

- `mcpServers`-Schlüssel (die Server-ID) müssen `^[a-z][a-z0-9_-]{0,63}$` entsprechen.
- HTTP-`url` muss als `http:` oder `https:` parsebar sein.
- Stdio-`command` ist auf `npx`, `node` oder `tsx` beschränkt.
- Einträge, die die Validierung nicht bestehen, werden beim Laden stillschweigend verworfen (eine Warnung wird protokolliert); der Rest der Datei wird weiterhin angewendet.

**Beispiel** — ein Stdio-Server mit Anmeldedaten, der auch unter der Docker-Sandbox läuft (z. B. ein IMAP-MCP):

```json
{
  "mcpServers": {
    "imap": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-imap-mcp"],
      "env": { "IMAP_HOST": "imap.example.com", "IMAP_USER": "me", "IMAP_PASS": "secret" },
      "hostExecInDocker": true,
      "enabled": true
    }
  }
}
```

`hostExecInDocker` führt diesen Server auf dem Host aus, außerhalb der Sandbox. Es ist ein Flag pro Server — aktiviere es für so viele Server, wie du brauchst, aber nur für vertrauenswürdige. Ist die Sandbox aus, wird es ignoriert (der Server läuft ohnehin auf dem Host).

**Beispiel-`settings.json`**:

```json
{
  "extraAllowedTools": ["mcp__claude_ai_Gmail", "mcp__claude_ai_Google_Calendar"]
}
```

Sie müssen `mcp__<id>`-Einträge für in `mcp.json` definierte Server nicht auflisten — diese sind automatisch bei jedem Agentenlauf erlaubt. `extraAllowedTools` ist nur für Tools gedacht, die nicht über Ihre eigenen `mcpServers` erreichbar sind, typischerweise die eingebauten `mcp__claude_ai_*`-Bridges von Claude Code, nachdem Sie `claude mcp` ausgeführt und OAuth abgeschlossen haben.

## Chat-Anhänge

Fügen Sie Dateien ein (Ctrl+V / Cmd+V) oder ziehen Sie sie per Drag-and-Drop in das Chat-Eingabefeld, um sie zusammen mit Ihrer Nachricht an Claude zu senden.

| Dateityp                                          | Was Claude sieht                | Abhängigkeit                 |
| ------------------------------------------------- | ------------------------------- | ---------------------------- |
| Bild (PNG, JPEG, GIF, WebP, …)                    | Vision-Inhaltsblock (nativ)     | Keine                        |
| PDF                                               | Dokumenten-Inhaltsblock (nativ) | Keine                        |
| Text (.txt, .csv, .json, .md, .xml, .html, .yaml) | Dekodierter UTF-8-Text          | Keine                        |
| DOCX                                              | Extrahierter Klartext           | `mammoth` (npm)              |
| XLSX                                              | CSV pro Blatt                   | `xlsx` (npm)                 |
| PPTX                                              | Konvertiert zu PDF              | LibreOffice (Docker-Sandbox) |

Die PPTX-Konvertierung läuft innerhalb des Docker-Sandbox-Images (`libreoffice --headless`). Ohne Docker schlägt eine Meldung vor, stattdessen zu PDF oder Bildern zu exportieren. Die maximale Anhanggröße beträgt 30 MB.

## Canvas-Ansichtsmodi

Das Canvas (rechtes Panel) unterstützt 8 Ansichtsmodi, umschaltbar über die Launcher-Toolbar, den URL-Query-Parameter oder Tastaturkürzel:

| Kürzel       | Ansicht   | URL-Parameter     | Beschreibung                         |
| ------------ | --------- | ----------------- | ------------------------------------ |
| `Cmd/Ctrl+1` | Single    | (Standard)        | Zeigt das ausgewählte Tool-Ergebnis  |
| `Cmd/Ctrl+2` | Stack     | `?view=stack`     | Alle Ergebnisse vertikal gestapelt   |
| `Cmd/Ctrl+3` | Files     | `?view=files`     | Workspace-Datei-Explorer             |
| `Cmd/Ctrl+5` | Scheduler | `?view=scheduler` | Kalender geplanter Aufgaben          |
| `Cmd/Ctrl+6` | Wiki      | `?view=wiki`      | Wiki-Seitenindex                     |
| `Cmd/Ctrl+7` | Skills    | `?view=skills`    | Skills-Liste und Editor              |
| `Cmd/Ctrl+8` | Roles     | `?view=roles`     | Rollenverwaltung                     |

Jeder Ansichtsmodus ist URL-gesteuert: Das Klicken auf eine Launcher-Schaltfläche aktualisiert `?view=`, und das Aufrufen einer URL mit `?view=wiki` (zum Beispiel) stellt die entsprechende Ansicht wieder her. Die Liste der Ansichtsmodi wird einmal in `src/utils/canvas/viewMode.ts` definiert — das Hinzufügen eines neuen Modus ist ein einzelnes Array-Append.

## Fernzugriff

Greifen Sie von einem Smartphone (oder einem beliebigen Browser) auf Ihr laufendes MulmoClaude zu — durchsuchen Sie Sammlungen, Feeds und benutzerdefinierte Ansichten und starten Sie Chats, von überall. Es ist kein separates Konto und kein zusätzlicher Server nötig: Der Zugriff wird einfach dadurch gewährt, dass Sie sich auf **beiden** Seiten mit **demselben Google-Konto** anmelden.

**So verbinden Sie sich**

1. Klicken Sie auf dem Desktop auf das **phonelink**-Symbol in der Kopfzeile, um das _Remote-Host_-Popover zu öffnen, und wählen Sie **Mit Google anmelden**. MulmoClaude meldet sich als Ihr Google-Nutzer an und öffnet einen Befehlskanal über Firebase (das gemeinsame öffentliche Projekt [`mulmoserver`](https://mulmoserver.web.app)). Das Symbol wird grün, solange der Host online ist.
2. Öffnen Sie auf Ihrem Smartphone **[https://mulmoserver.web.app](https://mulmoserver.web.app)** und melden Sie sich mit **demselben Google-Konto** an. Die Web-App findet Ihren Online-Host und verbindet sich mit ihm.

Da sich beide Seiten als derselbe Firebase-Nutzer authentifizieren, treffen sich Smartphone und Desktop nur innerhalb Ihres eigenen Nutzerbereichs — kein Dritter kann Ihren Host erreichen.

**Firebase und Firestore werden ausschließlich als Transport genutzt** — als Relais, das Befehle und Antworten zwischen Ihrem Smartphone und Ihrem Desktop weiterleitet. Ihre Daten werden auf keiner der beiden Seiten **gespeichert oder aufbewahrt**. Auf dem Host existieren nur Ihre lokalen Workspace-Dateien; alles, was den Kanal passieren muss (etwa ein über Firebase Storage bereitgestellter Anhang), wird gelöscht, sobald es sein Ziel erreicht hat.

**Was Sie vom Smartphone aus tun können**

- Ihre **Sammlungen** und **Feeds** durchsuchen und durchblättern.
- **Custom Remote Views** öffnen — mobilfreundliche Seiten, die Claude für Sie erstellt. Bitten Sie Claude, eine _custom remote view_ zu erstellen (keine normale Custom View); sie kann schreibgeschützt oder beschreibbar sein.
- Einen **Chat** auf dem Host **starten** und **Fotos, Videos oder PDFs** vom Smartphone anhängen. Die Bytes der Anhänge sind für den Befehlskanal zu groß, daher werden sie über Firebase Storage bereitgestellt; der Host lädt jede Datei in seinen Workspace (`data/attachments/`) herunter, löscht die bereitgestellte Kopie und übergibt die Datei zusammen mit Ihrer Nachricht an Claude.

Der Kanal ist befehlsbasiert und host-gesteuert: Das Smartphone stellt Anfragen und Ihr Desktop-MulmoClaude beantwortet sie. Verwenden Sie **Trennen** im Popover (oder beenden Sie MulmoClaude), um den Host offline zu nehmen.

## Workspace

Alle Daten werden als einfache Dateien im Workspace-Verzeichnis gespeichert, gruppiert in vier semantische Bereiche (#284):

```
~/mulmoclaude/
  config/              ← settings.json, mcp.json, roles/, helps/
  conversations/       ← chat/, memory.md, summaries/, searches/
  data/                ← wiki/, todos/, calendar/, contacts/, scheduler/,
                         sources/, transports/
  artifacts/           ← charts/, documents/, html/, html-scratch/,
                         images/, news/, spreadsheets/, stories/
```

Siehe [`docs/developer.md`](docs/developer.md#workspace-layout-mulmoclaude) für die vollständige Referenz.

### Todo-Listen

Todo-Listen werden als schema-gesteuerte **Collections** erstellt, nicht als dedizierte Ansicht. Bitten Sie Claude, „eine Todo-Liste einzurichten“, und es folgt `config/helps/todo-collection.md`, um eine `todos`-Collection zu erstellen — mit einem Status-Enum (`Backlog / Todo / In Progress / Done`), einem `done`-Toggle und optionalen Prioritäts- / Fälligkeitsdatumsfeldern, wobei je nach Schema automatisch eine Kanban- / Tabellen- / Kalenderansicht gewählt wird.

### Scheduler und Skill-Scheduling

Der Scheduler (`Cmd/Ctrl+5` oder `?view=scheduler`) verwaltet wiederkehrende Aufgaben, die in `data/scheduler/items.json` gespeichert werden. Der Scheduler-Kern (`@receptron/task-scheduler`) behandelt die Nachhol-Logik für verpasste Ausführungen und unterstützt `interval`-, `daily`- und `cron`-Zeitpläne.

Skills können zum automatischen Ausführen geplant werden, indem ein `schedule`-Feld zur SKILL.md-Frontmatter hinzugefügt wird:

```yaml
---
description: Morning news digest
schedule: daily 08:00
---
```

Claude registriert den Skill beim Scheduler, und er läuft automatisch nach dem angegebenen Zeitplan.

### Extraktion von Erinnerungen

Claude extrahiert automatisch dauerhafte Benutzerfakten aus Chat-Konversationen und hängt sie an `conversations/memory.md` an. Dies läuft als Teil des täglichen Journaldurchgangs — Fakten wie Essensvorlieben, Arbeitsgewohnheiten und Tool-Präferenzen werden ohne Benutzereingriff aus kürzlichen Chats destilliert. Die Memory-Datei wird immer in den Agentenkontext geladen, damit Claude die Antworten personalisieren kann.

## Monorepo-Pakete

Gemeinsam genutzter Code wird in veröffentlichbare npm-Pakete unter `packages/` extrahiert:

| Paket                       | Beschreibung                                      | Links                                                                                                   |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@mulmobridge/protocol`     | Gemeinsame Typen und Konstanten                   | [npm](https://www.npmjs.com/package/@mulmobridge/protocol) / [Quelle](packages/protocol/)               |
| `@mulmobridge/client`       | Socket.io-Client-Bibliothek                       | [npm](https://www.npmjs.com/package/@mulmobridge/client) / [Quelle](packages/client/)                   |
| `@mulmobridge/chat-service` | Serverseitiger Chat-Dienst (DI-Factory)           | [npm](https://www.npmjs.com/package/@mulmobridge/chat-service) / [Quelle](packages/chat-service/)       |
| `@mulmobridge/cli`          | Terminal-Bridge                                   | [npm](https://www.npmjs.com/package/@mulmobridge/cli) / [Quelle](packages/bridges/cli/)                 |
| `@mulmobridge/telegram`     | Telegram-Bot-Bridge                               | [npm](https://www.npmjs.com/package/@mulmobridge/telegram) / [Quelle](packages/bridges/telegram/)       |
| `@mulmobridge/slack`        | Slack-Bot-Bridge                                  | [npm](https://www.npmjs.com/package/@mulmobridge/slack) / [Quelle](packages/bridges/slack/)             |
| `@mulmobridge/discord`      | Discord-Bot-Bridge                                | [npm](https://www.npmjs.com/package/@mulmobridge/discord) / [Quelle](packages/bridges/discord/)         |
| `@mulmobridge/line`         | LINE-Bot-Bridge                                   | [npm](https://www.npmjs.com/package/@mulmobridge/line) / [Quelle](packages/bridges/line/)               |
| `@mulmobridge/whatsapp`     | WhatsApp-Bridge                                   | [npm](https://www.npmjs.com/package/@mulmobridge/whatsapp) / [Quelle](packages/bridges/whatsapp/)       |
| `@mulmobridge/matrix`       | Matrix-Bridge                                     | [npm](https://www.npmjs.com/package/@mulmobridge/matrix) / [Quelle](packages/bridges/matrix/)           |
| `@mulmobridge/irc`          | IRC-Bridge                                        | [npm](https://www.npmjs.com/package/@mulmobridge/irc) / [Quelle](packages/bridges/irc/)                 |
| `@mulmobridge/mattermost`   | Mattermost-Bridge                                 | [npm](https://www.npmjs.com/package/@mulmobridge/mattermost) / [Quelle](packages/bridges/mattermost/)   |
| `@mulmobridge/zulip`        | Zulip-Bridge                                      | [npm](https://www.npmjs.com/package/@mulmobridge/zulip) / [Quelle](packages/bridges/zulip/)             |
| `@mulmobridge/messenger`    | Facebook-Messenger-Bridge                         | [npm](https://www.npmjs.com/package/@mulmobridge/messenger) / [Quelle](packages/bridges/messenger/)     |
| `@mulmobridge/google-chat`  | Google-Chat-Bridge                                | [npm](https://www.npmjs.com/package/@mulmobridge/google-chat) / [Quelle](packages/bridges/google-chat/) |
| `@mulmobridge/mastodon`     | Mastodon-Bridge                                   | [npm](https://www.npmjs.com/package/@mulmobridge/mastodon) / [Quelle](packages/bridges/mastodon/)       |
| `@mulmobridge/bluesky`      | Bluesky-Bridge                                    | [npm](https://www.npmjs.com/package/@mulmobridge/bluesky) / [Quelle](packages/bridges/bluesky/)         |
| `@mulmobridge/chatwork`     | Chatwork-Bridge (japanischer Business-Chat)       | [npm](https://www.npmjs.com/package/@mulmobridge/chatwork) / [Quelle](packages/bridges/chatwork/)       |
| `@mulmobridge/xmpp`         | XMPP / Jabber-Bridge                              | [npm](https://www.npmjs.com/package/@mulmobridge/xmpp) / [Quelle](packages/bridges/xmpp/)               |
| `@mulmobridge/rocketchat`   | Rocket.Chat-Bridge                                | [npm](https://www.npmjs.com/package/@mulmobridge/rocketchat) / [Quelle](packages/bridges/rocketchat/)   |
| `@mulmobridge/signal`       | Signal-Bridge (via signal-cli-rest-api)           | [npm](https://www.npmjs.com/package/@mulmobridge/signal) / [Quelle](packages/bridges/signal/)           |
| `@mulmobridge/teams`        | Microsoft-Teams-Bridge (Bot Framework)            | [npm](https://www.npmjs.com/package/@mulmobridge/teams) / [Quelle](packages/bridges/teams/)             |
| `@mulmobridge/line-works`   | LINE-Works-Bridge (Enterprise LINE)               | [npm](https://www.npmjs.com/package/@mulmobridge/line-works) / [Quelle](packages/bridges/line-works/)   |
| `@mulmobridge/nostr`        | Nostr verschlüsselte DM-Bridge                    | [npm](https://www.npmjs.com/package/@mulmobridge/nostr) / [Quelle](packages/bridges/nostr/)             |
| `@mulmobridge/viber`        | Viber-Bridge                                      | [npm](https://www.npmjs.com/package/@mulmobridge/viber) / [Quelle](packages/bridges/viber/)             |
| `@mulmobridge/webhook`      | Generischer HTTP-Webhook-Bridge (Entwickler-Glue) | [npm](https://www.npmjs.com/package/@mulmobridge/webhook) / [Quelle](packages/bridges/webhook/)         |
| `@mulmobridge/twilio-sms`   | SMS via Twilio                                    | [npm](https://www.npmjs.com/package/@mulmobridge/twilio-sms) / [Quelle](packages/bridges/twilio-sms/)   |
| `@mulmobridge/email`        | Email-Bridge (IMAP + SMTP)                        | [npm](https://www.npmjs.com/package/@mulmobridge/email) / [Quelle](packages/bridges/email/)             |
| `@mulmobridge/mock-server`  | Mock-Server zum Testen                            | [npm](https://www.npmjs.com/package/@mulmobridge/mock-server) / [Quelle](packages/mock-server/)         |
| `@receptron/task-scheduler` | Persistenter Task-Scheduler                       | [npm](https://www.npmjs.com/package/@receptron/task-scheduler) / [Quelle](packages/scheduler/)          |

Jeder kann eine Bridge in beliebiger Sprache schreiben — sprechen Sie einfach das socket.io-Protokoll, das in [`docs/bridge-protocol.md`](docs/bridge-protocol.md) dokumentiert ist.

## Dokumentation

Die vollständige Dokumentation befindet sich unter [`docs/`](docs/README.md). Hier sind die wichtigsten Einstiegspunkte:

### Für Benutzer

| Anleitung                                                                                                        | Beschreibung                                                                |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [MulmoBridge-Anleitung](docs/mulmobridge-guide.en.md) / [日本語](docs/mulmobridge-guide.md)                      | Verbinden Sie Messaging-Apps (Telegram, Slack, LINE usw.) mit Ihrem Heim-PC |
| [Scheduler-Anleitung](docs/scheduler-guide.en.md) / [日本語](docs/scheduler-guide.md)                            | Wiederkehrende automatische Aufgaben                                        |
| [Obsidian-Integration](docs/tips/obsidian.en.md) / [日本語](docs/tips/obsidian.md)                               | Verwenden Sie Obsidian, um MulmoClaudes Wiki und Dokumente zu durchsuchen   |
| [Telegram-Einrichtung](docs/message_apps/telegram/README.md) / [日本語](docs/message_apps/telegram/README.ja.md) | Schritt-für-Schritt-Einrichtung des Telegram-Bots                           |
| [LINE-Einrichtung](docs/message_apps/line/README.md) / [日本語](docs/message_apps/line/README.ja.md)             | Schritt-für-Schritt-Einrichtung des LINE-Bots                               |

### Für Entwickler

| Anleitung                                                   | Beschreibung                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Entwicklerhandbuch](docs/developer.md)                     | Umgebungsvariablen, Skripte, Workspace-Struktur, CI                     |
| [Bridge-Protokoll](docs/bridge-protocol.md)                 | Wire-Level-Spezifikation zum Schreiben neuer Messaging-Bridges          |
| [Sandbox-Anmeldeinformationen](docs/sandbox-credentials.md) | Docker-Sandbox-Weiterleitung von Anmeldeinformationen (SSH, GitHub CLI) |
| [Logging](docs/logging.md)                                  | Log-Level, Formate, Dateirotation                                       |
| [Troubleshooting](docs/troubleshooting.md)                  | Setup-Probleme — kaputt wirkende UI, `dist/*`-404s, Windows/OneDrive, `401` nach Neustart, Boot-Warnungen |
| [CHANGELOG](docs/CHANGELOG.md)                              | Release-Historie                                                        |

## Lizenz

MIT — siehe [LICENSE](LICENSE).
