# MulmoClaude

[![npm version](https://img.shields.io/npm/v/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![npm downloads](https://img.shields.io/npm/dm/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![License: MIT](https://img.shields.io/npm/l/mulmoclaude.svg)](LICENSE)
[![CI](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml/badge.svg)](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml)
[![GitHub stars](https://img.shields.io/github/stars/receptron/mulmoclaude.svg?style=social)](https://github.com/receptron/mulmoclaude/stargazers)

[English](README.md) · [日本語](README.ja.md) · [简体中文](README.zh.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português (BR)](README.pt-BR.md) · **Français** · [Deutsch](README.de.md)

**Un assistant IA qui sait tout de vous et vous accompagne 24 heures sur 24 ne se vend nulle part. Vous ne pouvez pas en acheter un — vous ne pouvez que le cultiver. MulmoClaude est un outil pour cultiver votre propre assistant IA, sur votre propre ordinateur.**

La substance d'un assistant n'est pas le modèle d'IA — le modèle n'est que le moteur. Ce qui fait la valeur d'un assistant, c'est tout ce qu'il sait de vous : vos conversations, votre agenda, vos notes, vos données et les applications que vous utilisez. Une chose aussi importante ne devrait être confiée à aucun fournisseur de services — plus vous l'utilisez, plus il devient difficile de partir. MulmoClaude est open source et s'exécute localement : tout ce que votre assistant accumule — souvenirs, données, applications — reste entre vos mains, sous forme de simples fichiers dans votre workspace.

Cultiver demande un environnement, et MulmoClaude en fournit un : un lieu pour accumuler des souvenirs (un wiki personnel que Claude construit et entretient lui-même), un lieu pour conserver vos données (collections pilotées par schéma, flux, fichiers simples) et un lieu pour créer des applications rien que pour vous — sans aucune connaissance en programmation. Vous dites « je voudrais quelque chose comme ça » avec des mots de tous les jours, et Claude construit la petite application dont vous avez besoin : une liste de restaurants, un suivi de factures, des exercices de vocabulaire — du logiciel pour un public d'une seule personne. Juste après l'installation, le jardin est encore vide ; vous semez des graines, vous soignez la terre, et vous cultivez un assistant qui n'appartient qu'à vous.

Et l'assistant n'est pas attaché à votre bureau. Connectez-vous depuis votre téléphone — ou depuis une application de messagerie que vous utilisez déjà — et vous retrouvez le même assistant qui vit sur votre ordinateur. Le serveur relais ne fait que transporter des messages en transit — vos souvenirs, vos données et vos applications ne quittent jamais votre ordinateur.

Sous le capot, MulmoClaude est une plateforme d'applications AI-natives : les capacités sont des plugins au sein d'un unique registre (aujourd'hui : un système comptable complet avec une véritable logique de tenue de livres côté serveur, un wiki personnel, un lecteur de documents SEC, et plus encore), Claude agit comme un contrôleur universel qui compose à travers eux, et le chat invoque la bonne GUI pour chaque tâche — markdown, graphiques, formulaires, wikis, feuilles de calcul ou scènes 3D.

> **[How AI-Native Applications Should Be Built](MANIFEST.md)** — la thèse architecturale, UX et protocolaire derrière MulmoClaude.

## 📣 Actualités

Les nouvelles versions et fonctionnalités sont annoncées **en japonais** sur X.

- [Singularity Society (@SingularitySoci)](https://x.com/SingularitySoci) — annonces de versions et de nouvelles fonctionnalités
- [Satoshi Nakajima (@snakajima)](https://x.com/snakajima) — propriétaire de MulmoClaude

## Démarrage rapide

```bash
npx mulmoclaude@latest
```

Le lanceur démarre le serveur et ouvre [http://localhost:3001](http://localhost:3001) dans votre navigateur. C'est tout — commencez à discuter.

> **Pour le garder actif** : fermer le terminal arrête le serveur. Pour l'exécuter en arrière-plan, lancez-le dans `tmux` / `screen` (macOS/Linux) ou enregistrez-le comme tâche au démarrage dans le Planificateur de tâches Windows.

### Prérequis

- **Node.js 22.19+** — environnement d'exécution
- **[Claude Code CLI](https://claude.ai/code)** — installé et authentifié. Exécutez `claude` une fois pour terminer l'OAuth
- **ffmpeg** — requis pour la génération de vidéos. À ignorer si vous ne générez pas de vidéos
  - macOS : `brew install ffmpeg`
  - Linux : `apt install ffmpeg`
  - Windows : `winget install Gyan.FFmpeg`
- **Docker Desktop** (optionnel mais recommandé) — active le mode bac à sable. Voir [Installer Docker Desktop](#installer-docker-desktop) ci-dessous

> **Langue de l'interface** : 8 langues sont prises en charge (anglais, japonais, chinois, coréen, espagnol, portugais (BR), français, allemand). Par défaut, la langue est détectée automatiquement à partir de la langue du navigateur / du système d'exploitation. Pour l'indiquer explicitement, définissez `VITE_LOCALE=fr` dans `.env`. La locale est choisie au moment de la compilation / du développement ; redémarrez `yarn dev` après l'avoir modifiée. Consultez [`docs/developer.md`](docs/developer.md#i18n-vue-i18n) pour savoir comment ajouter des chaînes de caractères.

### Exécuter depuis le code source (pour les développeurs)

Pour modifier le code au lieu de simplement l'exécuter :

```bash
git clone git@github.com:receptron/mulmoclaude.git
cd mulmoclaude && yarn install
cp .env.example .env   # optionnel — ajoutez GEMINI_API_KEY pour la génération d'images
yarn dev
```

Ouvrez [http://localhost:5173](http://localhost:5173). Voir [`docs/developer.md`](docs/developer.md) pour l'architecture et les scripts.

> **L'interface paraît cassée ou sans style ?** Icônes affichées en toutes lettres, `404` sur `dist/*`, `401` après un redémarrage — voir [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Que pouvez-vous faire ?

| Demandez à Claude de...                              | Ce que vous obtenez                                            |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| « Rédige une proposition de projet »                 | Document markdown riche affiché dans le canevas                |
| « Trace le chiffre d'affaires du dernier trimestre » | Visualisation ECharts interactive                              |
| « Crée un plan de voyage pour Kyoto »                | Guide illustré avec des images                                 |
| « Gère ma liste de tâches »                          | Tableau Kanban avec glisser-déposer                            |
| « Ingère cet article : URL »                         | Page de wiki avec des `[[links]]` pour la mémoire à long terme |
| « Planifie une revue de presse quotidienne »         | Tâche récurrente exécutée automatiquement                      |
| « Génère une image d'un coucher de soleil »          | Image générée par IA (Gemini)                                  |
| « Abonne-toi à ce flux RSS »                         | Flux de données sur `/feeds`, récupéré à intervalles           |
| « Quoi de neuf dans mes flux ? »                     | Éléments de flux regroupés sur `/feeds`                        |

> **Pages accessibles directement** : `/wiki` (parcourir + Lint), `/feeds` (flux de données), `/collections` (apps de données), `/automations` (tâches récurrentes), `/files`, `/skills`, `/roles`. Chaque page possède son propre composeur de chat qui démarre une nouvelle conversation déjà contextualisée par la page.

> **Vous bidouillez MulmoClaude ?** Consultez [`docs/developer.md`](docs/developer.md) pour les variables d'environnement, les scripts et l'architecture.

<a id="messaging-bridges"></a>
### Ponts de messagerie

MulmoClaude est accessible depuis des applications de messagerie via des **processus de pont**. Les ponts s'exécutent en tant que processus enfants distincts et se connectent au serveur via socket.io.

```bash
# Interactive CLI bridge (same machine)
yarn cli

# Telegram bot bridge (requires TELEGRAM_BOT_TOKEN in .env)
yarn telegram
```

Les ponts sont également disponibles en tant que paquets npm autonomes :

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

Tous les ponts prennent en charge le **streaming de texte en temps réel** (mises à jour en cours de frappe au fur et à mesure que l'agent écrit). CLI et Telegram prennent également en charge les **pièces jointes** (images, PDF, DOCX, XLSX, PPTX). Consultez [`docs/mulmobridge-guide.md`](docs/mulmobridge-guide.md) pour la liste complète des plateformes et les instructions de configuration.

### Pourquoi avez-vous besoin d'une clé d'API Gemini ?

MulmoClaude utilise le modèle **Gemini 3.1 Flash Image (nano banana 2)** de Google pour la génération et l'édition d'images. Cela alimente :

- `generateImage` — crée des images à partir de descriptions textuelles
- `editImage` — transforme ou modifie une image existante (par exemple, « convertir au style Ghibli »)
- Images en ligne intégrées aux documents (guide de recettes, planificateur de voyage, etc.)

Sans clé d'API Gemini, les rôles qui utilisent la génération d'images seront désactivés dans l'interface.

### Obtenir une clé d'API Gemini

1. Rendez-vous sur [Google AI Studio](https://aistudio.google.com/apikey)
2. Connectez-vous avec votre compte Google
3. Cliquez sur **Create API key**
4. Copiez la clé et collez-la dans votre fichier `.env` sous la forme `GEMINI_API_KEY=...`

L'API Gemini propose un niveau gratuit suffisant pour un usage personnel.

<a id="security"></a>
## Sécurité

MulmoClaude utilise Claude Code comme moteur IA, lequel a accès à des outils incluant Bash — ce qui signifie qu'il peut lire et écrire des fichiers sur votre machine.

**Sans Docker**, Claude peut accéder à tout fichier accessible par votre compte utilisateur, y compris les clés SSH et les identifiants stockés en dehors de votre espace de travail. C'est acceptable pour un usage local personnel, mais bon à savoir.

**Avec Docker Desktop installé**, MulmoClaude exécute automatiquement Claude à l'intérieur d'un conteneur isolé (sandbox). Seuls votre espace de travail et la configuration propre à Claude (`~/.claude`) sont montés — le reste de votre système de fichiers est invisible pour Claude. Aucune configuration n'est requise : l'application détecte Docker au démarrage et active le bac à sable automatiquement.

**Authentification par jeton Bearer** : chaque point de terminaison `/api/*` requiert un en-tête `Authorization: Bearer <token>`. Le jeton est généré automatiquement au démarrage du serveur et injecté dans le navigateur via une balise `<meta>` — aucune configuration manuelle. La seule exception est `/api/files/*` (exempté car les balises `<img>` dans les documents rendus ne peuvent pas attacher d'en-têtes). Voir [`docs/developer.md`](docs/developer.md#auth-bearer-token-on-api) pour plus de détails.

**Transfert d'identifiants au bac à sable** (opt-in) : par défaut, le bac à sable n'a aucun accès aux identifiants de l'hôte. Deux variables d'environnement vous permettent d'exposer de manière sélective ce dont `git` / `gh` ont besoin :

- `SANDBOX_SSH_AGENT_FORWARD=1` — transfère la socket de l'agent SSH de l'hôte. Les clés privées restent sur l'hôte.
- `SANDBOX_MOUNT_CONFIGS=gh,gitconfig` — monte `~/.config/gh` et `~/.gitconfig` en lecture seule.

Contrat complet et notes de sécurité : [`docs/sandbox-credentials.md`](docs/sandbox-credentials.md).

### Installer Docker Desktop

1. Téléchargez Docker Desktop depuis [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
2. **macOS** : ouvrez le `.dmg` et faites glisser Docker dans Applications, puis lancez-le depuis Applications
3. **Windows** : exécutez le programme d'installation et suivez les instructions (WSL2 est configuré automatiquement si nécessaire)
4. **Linux** : suivez le [guide d'installation Linux](https://docs.docker.com/desktop/install/linux/)
5. Attendez que Docker Desktop termine son démarrage — l'icône de baleine dans la barre de menus / la zone de notification doit devenir fixe (non animée)
6. Redémarrez MulmoClaude — il détectera Docker et construira l'image du bac à sable au premier lancement (une seule fois, cela prend environ une minute)

Lorsque le bac à sable Docker est actif sur macOS, les identifiants sont gérés automatiquement — l'application extrait les jetons OAuth du Trousseau du système au démarrage et les rafraîchit en cas d'erreur 401, aucune étape manuelle n'est donc nécessaire.

Si Docker n'est pas installé, l'application affiche un bandeau d'avertissement et continue de fonctionner sans isolation.

> **Mode débogage** : pour exécuter sans le bac à sable même si Docker est installé, définissez `DISABLE_SANDBOX=1` avant de démarrer le serveur, ou passez le drapeau CLI `--disable-sandbox` (`yarn dev --disable-sandbox` / `npx mulmoclaude --disable-sandbox` ; fonctionne sous Windows PowerShell).
>
> **Historique des appels d'outils** : définissez `PERSIST_TOOL_CALLS=1` pour enregistrer aussi les événements `tool_call` (avec leurs `args`) dans le jsonl de session aux côtés de `tool_result`. Désactivé par défaut car les `args` peuvent être volumineux et contenir des octets de charge utile (images en base64, JSON MulmoScript) que vous ne souhaitez pas écrire sur disque ; utile pour déboguer après un rafraîchissement de page ou un redémarrage du serveur. Voir [issue #1096](https://github.com/receptron/mulmoclaude/issues/1096).

## Journalisation

Le serveur écrit du texte lisible dans la console et du JSON complet dans des fichiers quotidiens à rotation sous `server/system/logs/`. Tout est configurable via `LOG_LEVEL`, `LOG_*_FORMAT`, `LOG_FILE_DIR`, etc.

Consultez [docs/logging.md](docs/logging.md) pour la référence complète, des exemples de format, le comportement de rotation et des recettes.

## Rôles

Chaque rôle donne à Claude une personnalité différente, une palette d'outils et un domaine de prédilection :

| Rôle                | Description                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------- |
| **General**         | Assistant polyvalent — tâches, planificateur, wiki, documents, cartes mentales                |
| **Office**          | Documents, feuilles de calcul, formulaires, présentations, tableaux de bord de données        |
| **Guide & Planner** | Guides de voyage, livres de recettes, planificateurs de voyage avec une sortie visuelle riche |
| **Artist**          | Génération d'images, édition d'images, art génératif avec p5.js                               |
| **Tutor**           | Enseignement adaptatif — évalue votre niveau avant d'expliquer quoi que ce soit               |
| **Storyteller**     | Histoires illustrées interactives avec images et scènes HTML                                  |

Changer de rôle réinitialise le contexte de Claude et n'y injecte que les outils nécessaires à ce rôle — ce qui maintient les réponses rapides et ciblées.

## Skills — Exécutez vos Claude Code Skills depuis MulmoClaude

MulmoClaude peut lister et lancer les **Claude Code skills** que vous avez déjà. Une skill est n'importe quel dossier sous `~/.claude/skills/<name>/` contenant un fichier `SKILL.md` avec une `description` dans le frontmatter YAML et un corps markdown d'instructions. Consultez la [documentation Claude Code Skills](https://docs.claude.com/en/docs/claude-code/skills) pour plus de détails sur la création de skills.

### Comment l'utiliser

1. Ouvrez MulmoClaude et restez dans l'un des rôles prenant en charge les skills : **General**, **Office** ou **Tutor**.
2. Demandez à Claude de montrer vos skills — par exemple _« montre mes skills »_ ou _« liste les skills »_.
3. Claude invoque l'outil `manageSkills`, et une vue **Skills** en volet divisé s'ouvre dans le canevas :
   - **Gauche** : chaque skill découverte sur votre machine, avec sa description et son badge de portée (`USER` / `PROJECT`).
   - **Droite** : le contenu complet du `SKILL.md` de la skill sélectionnée.
4. Cliquez sur **Run** sur une skill. MulmoClaude envoie `/<skill-name>` à Claude sous forme de message de chat classique ; le mécanisme de commandes slash de Claude Code le résout contre `~/.claude/skills/` et exécute les instructions de la skill en ligne dans la même session de chat.

Aucune saisie supplémentaire, aucun copier-coller du corps de SKILL.md — le bouton Run est un simple clic autour de `/skill-name`.

### Découverte des skills — deux portées

| Portée      | Emplacement                            | Sémantique                                                                                                               |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **User**    | `~/.claude/skills/<name>/SKILL.md`     | Skills personnelles, partagées entre tous les projets que vous ouvrez avec la CLI Claude.                                |
| **Project** | `~/mulmoclaude/.claude/skills/<name>/` | Skills limitées à l'espace de travail MulmoClaude. La portée project **l'emporte** en cas de collision de nom avec user. |

Les deux portées sont en lecture seule en phase 0 — les modifications se font au niveau du système de fichiers. Une future version permettra à MulmoClaude lui-même de créer / éditer des skills de portée project.

### Bac à sable Docker vs non-Docker

Le **mode bac à sable Docker** par défaut de MulmoClaude isole Claude Code dans un conteneur pour des raisons de sécurité (voir [Sécurité](#security)). Le comportement des skills diffère entre les deux modes :

| Mode                                 | Skills user (`~/.claude/skills/`)     | Skills project (`~/mulmoclaude/.claude/skills/`) | Skills intégrées de la CLI (`/simplify`, `/update-config`, …) |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| **Non-Docker** (`DISABLE_SANDBOX=1`) | ✅ Toutes fonctionnent                | ✅                                               | ✅                                                            |
| **Bac à sable Docker** (par défaut)  | ⚠️ Voir les mises en garde ci-dessous | ✅ Monté via le volume d'espace de travail       | ✅                                                            |

**Mises en garde Docker — pourquoi les skills user ne fonctionnent parfois pas dans le bac à sable :**

- **`~/.claude/skills/` en lien symbolique** — si votre `~/.claude/skills` (ou toute sous-entrée) est un lien symbolique pointant en dehors de `~/.claude/` (par exemple `~/.claude/skills → ~/ss/dotfiles/claude/skills`), la cible du lien symbolique n'est pas présente à l'intérieur du conteneur. Le lien apparaît comme **cassé**, et Claude Code se replie uniquement sur les skills intégrées.
- **CLI Claude plus ancienne dans l'image du bac à sable** — `Dockerfile.sandbox` épingle la version de la CLI au moment de la construction de l'image. Si cette version est en retard par rapport à votre CLI hôte (par ex. 2.1.96 dans l'image contre 2.1.105 sur l'hôte), la découverte des skills user peut se comporter différemment.

**Solutions de contournement pour les configurations riches en skills qui ne s'entendent pas bien avec le bac à sable :**

1. **Désactiver le bac à sable pour cette session** :

   ```bash
   # env-var form (any shell supporting VAR=value)
   DISABLE_SANDBOX=1 yarn dev

   # or the equivalent --disable-sandbox CLI flag (Windows PowerShell / npx / IDE run configs)
   yarn dev --disable-sandbox
   npx mulmoclaude --disable-sandbox
   ```

   La CLI Claude s'exécute avec votre véritable `~/.claude/` et tout se résout nativement. Utilisez ceci lorsque vous avez confiance dans les prompts que vous êtes sur le point d'envoyer — le bac à sable reste la valeur par défaut recommandée pour un travail non fiable / exploratoire.

2. **Déplacer les skills dans la portée project** — copiez les skills spécifiques que vous souhaitez dans `~/mulmoclaude/.claude/skills/` (ce chemin est monté comme volume d'espace de travail à l'intérieur du bac à sable, donc pas de drame de lien symbolique). Idéal pour les skills qui sont de toute façon spécifiques à votre workflow MulmoClaude.

3. **Aplatir les liens symboliques** — si vous maintenez votre bibliothèque de skills via des liens symboliques (par ex. dans un dépôt dotfiles), remplacer le lien symbolique `~/.claude/skills` de premier niveau par le répertoire réel est la solution la plus simple.

### Ce que la skill reçoit réellement

Lorsque vous appuyez sur **Run**, MulmoClaude envoie un tour utilisateur simple contenant la chaîne de commande slash :

```text
/my-skill-name
```

C'est toute la charge utile — MulmoClaude **n'intègre pas** le corps du `SKILL.md` ni de contexte supplémentaire. Le corps est ce que Claude Code lit lorsque la CLI résout la commande slash de son côté. Cela maintient la saisie de chat petite et rend les longues skills (`SKILL.md` de plusieurs kilo-octets) sûres à exécuter sans faire exploser le contexte du prompt.

### Enregistrer une conversation comme nouvelle skill

Après une conversation productive, vous pouvez demander à MulmoClaude de capturer le workflow :

```text
"この会話を fix-ci という skill にして"
"save this as a skill called publish-flow"
"skill 化して"   ← Claude picks a slug for you
```

Claude lit la transcription de chat actuelle, distille les étapes que vous avez suivies et écrit un nouveau `SKILL.md` dans `~/mulmoclaude/.claude/skills/<slug>/`. La skill apparaît immédiatement dans la vue Skills et peut être invoquée via `/<slug>` dans toute session future.

Notes sur l'enregistrement :

- **Portée project uniquement** — les enregistrements vont dans `~/mulmoclaude/.claude/skills/`, jamais dans `~/.claude/skills/`. La portée user reste en lecture seule depuis MulmoClaude.
- **Pas d'écrasement** — si une skill portant le même nom existe déjà (dans l'une ou l'autre portée), l'enregistrement échoue et Claude vous demandera un nom différent.
- **Règles pour le slug** — lettres minuscules, chiffres et tirets ; 1–64 caractères ; pas de tirets en début / fin ou consécutifs. Claude en choisit un automatiquement ; si vous voulez un nom spécifique, mentionnez-le dans la demande.

### Supprimer une skill enregistrée

Les skills de portée project obtiennent un bouton **Delete** à côté du bouton Run dans la vue Skills (les skills de portée user sont en lecture seule — pas de bouton Delete affiché). Confirmer la boîte de dialogue supprime `~/mulmoclaude/.claude/skills/<slug>/SKILL.md`. Si vous avez également déposé des fichiers supplémentaires dans ce dossier à la main, ils restent en place ; seul le SKILL.md est supprimé.

Vous pouvez également demander à Claude de supprimer par nom :

```text
"delete the fix-ci skill"
```

## Wiki — Mémoire à long terme pour Claude Code

MulmoClaude inclut une **base de connaissances personnelle** inspirée de [l'idée LLM Knowledge Bases d'Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Elle donne à Claude Code une véritable mémoire à long terme — pas seulement un court `memory.md`, mais un wiki interconnecté qui grandit et que Claude construit et maintient lui-même.

Le rôle **General** inclut la prise en charge du wiki. Essayez :

- `"Ingest this article: <URL>"` — Claude récupère la page, extrait les connaissances clés, crée ou met à jour des pages de wiki, et consigne l'activité
- `"What does my wiki say about transformers?"` — Claude recherche l'index, lit les pages pertinentes et synthétise une réponse fondée
- `"Lint my wiki"` — contrôle de santé pour les pages orphelines, les liens cassés et les entrées d'index manquantes
- `"Show me the wiki index"` — affiche le catalogue complet des pages dans le canevas

### Comment ça marche

Le wiki vit entièrement sous forme de fichiers markdown en clair dans votre espace de travail :

```
<workspace>/data/wiki/
  index.md          ← catalog of all pages (title, description, last updated)
  log.md            ← append-only activity log
  pages/<slug>.md   ← one page per entity, concept, or theme
  sources/<slug>.md ← raw ingested sources
```

Claude utilise ses outils de fichiers intégrés (`read`, `write`, `glob`, `grep`) pour naviguer et maintenir le wiki — aucune base de données ou indexation spéciale n'est requise. Les références croisées utilisent la syntaxe `[[wiki link]]`, que l'interface canvas rend sous forme de navigation cliquable.

Au fil du temps, le wiki se développe en une base de connaissances personnelle que n'importe quel rôle peut consulter, rendant Claude progressivement plus utile plus vous l'utilisez.

## Graphiques (ECharts)

Le plugin `presentChart` affiche des visualisations [Apache ECharts](https://echarts.apache.org/) dans le canevas. Demandez une courbe, un histogramme, un graphique en chandeliers, un sankey, une carte thermique ou un graphe en réseau — Claude écrit un objet d'options ECharts, et le plugin le monte. Chaque graphique dispose d'un bouton **[↓ PNG]** pour un export en un clic.

Disponible dans les rôles **General**, **Office**, **Guide & Planner** et **Tutor**. Essayez :

```text
Chart last quarter's revenue by region as a bar chart
Plot AAPL's daily closes for the last 30 days as a candlestick
Show a sankey of energy flow: coal/gas/solar → electricity → home/industry/transport
```

### Stockage

Chaque appel `presentChart` écrit un fichier sous `<workspace>/artifacts/charts/` :

```text
<workspace>/artifacts/charts/
  sales-overview-1776135210389.chart.json
  apple-stock-1776135300000.chart.json
```

Un seul document peut contenir un nombre quelconque de graphiques, qui sont rendus empilés dans le canevas :

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

Le champ `option` est passé tel quel à la méthode [`setOption`](https://echarts.apache.org/en/api.html#echartsInstance.setOption) d'ECharts — vous pouvez consulter la [référence complète des options ECharts](https://echarts.apache.org/en/option.html) pour éditer ces fichiers à la main. Les modifications sont reflétées la prochaine fois que le document est rouvert dans le canevas.

## Optionnel : outils MCP X (Twitter)

MulmoClaude inclut des outils MCP optionnels pour lire et rechercher des publications sur X (Twitter) via l'API officielle X v2.

| Outil       | Description                                                |
| ----------- | ---------------------------------------------------------- |
| `readXPost` | Récupère une publication unique par URL ou ID de tweet     |
| `searchX`   | Recherche les publications récentes par mot-clé ou requête |

Ces outils sont **désactivés par défaut** et requièrent un jeton Bearer de l'API X pour être activés.

### Configuration

1. Rendez-vous sur [console.x.com](https://console.x.com) et connectez-vous avec votre compte X
2. Créez une nouvelle application — un jeton Bearer est généré automatiquement
3. Copiez le jeton Bearer et ajoutez-le à votre `.env` :
   ```
   X_BEARER_TOKEN=your_bearer_token_here
   ```
4. Ajoutez des crédits à votre compte sur [console.x.com](https://console.x.com) (requis pour effectuer des appels API)
5. Redémarrez le serveur de développement — les outils s'activent automatiquement

### Utilisation

Ces outils sont **uniquement disponibles dans les rôles personnalisés**. Les rôles intégrés ne les incluent pas par défaut (sauf General). Pour les utiliser dans votre propre rôle :

1. Créez ou modifiez un fichier JSON de rôle personnalisé dans `~/mulmoclaude/roles/<id>.json`
2. Ajoutez `readXPost` et/ou `searchX` à sa liste `availablePlugins`

Une fois configuré, vous pouvez coller n'importe quelle URL `x.com` ou `twitter.com` dans le chat et Claude la récupérera et la lira automatiquement.

## Configurer des outils supplémentaires (paramètres web)

L'icône d'engrenage dans la barre latérale ouvre une modale Paramètres où vous pouvez étendre l'ensemble d'outils de Claude sans modifier de code. Les changements s'appliquent au message suivant (aucun redémarrage du serveur requis).

### Onglet Allowed Tools

Collez les noms d'outils, un par ligne. Utile pour les serveurs MCP intégrés de Claude Code (Gmail, Google Calendar) après une poignée de main OAuth unique :

```text
mcp__claude_ai_Gmail
mcp__claude_ai_Google_Calendar
```

Exécutez d'abord `claude mcp` une fois dans un terminal et complétez le flux OAuth pour chaque service — les identifiants persistent sous `~/.claude/`.

### Onglet MCP Servers

Ajoutez des serveurs MCP externes sans éditer le JSON à la main. Deux types sont pris en charge :

- **HTTP** — serveurs distants (par ex. `https://example.com/mcp`). Fonctionne dans tous les modes ; dans Docker, les URL `localhost` / `127.0.0.1` sont réécrites automatiquement en `host.docker.internal`.
- **Stdio** — sous-processus local (p. ex. un MCP `npx`), limité à `npx` / `node` / `tsx` pour la sécurité. S'exécute sur l'hôte lorsque l'isolation Docker est **désactivée**. Lorsqu'elle est **activée**, les entrées stdio sont **ignorées par défaut** (l'image d'isolation minimale ne peut pas héberger des runtimes arbitraires) — utilisez `"hostExecInDocker": true` pour en exécuter un sur l'hôte derrière une passerelle `stdio ↔ HTTP`. Voir [docs/mcp-sandbox.md](docs/mcp-sandbox.md).

Transmettez les identifiants à un serveur stdio via une table **`env`** (`"env": { "IMAP_PASS": "…" }`). Les valeurs sont littérales et stockées dans `mcp.json` (mode `0600`, mais **en clair** — protection par permissions de fichier, pas un coffre-fort). Tous les détails, y compris l'option `hostExecInDocker` et la façon dont `env` atteint le processus, sont dans [docs/mcp-sandbox.md](docs/mcp-sandbox.md).

La configuration se trouve sous `<workspace>/config/` :

```text
<workspace>/config/
  settings.json    ← extra allowed tool names
  mcp.json         ← Claude CLI --mcp-config compatible
```

Le fichier MCP utilise le format standard de la CLI Claude afin que vous puissiez le copier entre les machines, ou même l'utiliser directement avec la CLI `claude`.

### Modifier directement les fichiers de configuration

Les deux fichiers sont du JSON simple — vous pouvez les modifier avec n'importe quel éditeur de texte au lieu de l'interface Paramètres. Le serveur les relit à chaque message, donc :

- Aucun redémarrage du serveur requis après une modification de fichier.
- Les changements sont également pris en compte par l'interface Paramètres — il suffit de fermer et rouvrir la modale.
- L'interface et le fichier sont toujours synchronisés : enregistrer depuis l'interface écrase le fichier, et les éditions manuelles apparaissent dans l'interface à la prochaine ouverture.

C'est pratique pour :

- Importer en masse des serveurs MCP depuis un autre poste de travail (copier `mcp.json`).
- Versionner votre configuration dans un dépôt dotfiles.
- Commenter temporairement un serveur en basculant `"enabled": false`.

**Exemple `mcp.json`** — un serveur HTTP distant (public, sans authentification) et un serveur stdio local :

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

Contraintes appliquées par le serveur lors du chargement du fichier :

- Les clés `mcpServers` (l'id du serveur) doivent correspondre à `^[a-z][a-z0-9_-]{0,63}$`.
- `url` HTTP doit s'analyser comme `http:` ou `https:`.
- `command` stdio est limité à `npx`, `node` ou `tsx`.
- Les entrées qui échouent à la validation sont silencieusement ignorées au chargement (un avertissement est consigné) ; le reste du fichier s'applique tout de même.

**Exemple** — un serveur stdio avec identifiants qui fonctionne aussi sous l'isolation Docker (p. ex. un MCP IMAP) :

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

`hostExecInDocker` exécute ce serveur sur l'hôte, hors de l'isolation. C'est une option par serveur — activez-la pour autant de serveurs que nécessaire, mais uniquement ceux de confiance. Sans l'isolation, elle est ignorée (le serveur s'exécute déjà sur l'hôte).

**Exemple `settings.json`** :

```json
{
  "extraAllowedTools": ["mcp__claude_ai_Gmail", "mcp__claude_ai_Google_Calendar"]
}
```

Vous n'avez pas besoin de lister les entrées `mcp__<id>` pour les serveurs définis dans `mcp.json` — celles-ci sont autorisées automatiquement à chaque exécution de l'agent. `extraAllowedTools` est uniquement pour les outils qui ne sont pas accessibles via vos propres `mcpServers`, typiquement les ponts `mcp__claude_ai_*` intégrés de Claude Code après que vous avez exécuté `claude mcp` et complété OAuth.

## Pièces jointes de chat

Collez (Ctrl+V / Cmd+V) ou glissez-déposez des fichiers dans la zone de saisie du chat pour les envoyer à Claude avec votre message.

| Type de fichier                                    | Ce que Claude voit               | Dépendance                       |
| -------------------------------------------------- | -------------------------------- | -------------------------------- |
| Image (PNG, JPEG, GIF, WebP, …)                    | Bloc de contenu vision (natif)   | Aucune                           |
| PDF                                                | Bloc de contenu document (natif) | Aucune                           |
| Texte (.txt, .csv, .json, .md, .xml, .html, .yaml) | Texte UTF-8 décodé               | Aucune                           |
| DOCX                                               | Texte brut extrait               | `mammoth` (npm)                  |
| XLSX                                               | CSV par feuille                  | `xlsx` (npm)                     |
| PPTX                                               | Converti en PDF                  | LibreOffice (bac à sable Docker) |

La conversion PPTX s'exécute à l'intérieur de l'image du bac à sable Docker (`libreoffice --headless`). Sans Docker, un message suggère d'exporter plutôt en PDF ou en images. La taille maximale des pièces jointes est de 30 Mo.

## Modes d'affichage du canevas

Le canevas (panneau de droite) prend en charge 8 modes d'affichage, permutables via la barre d'outils du lanceur, le paramètre d'URL ou un raccourci clavier :

| Raccourci    | Vue       | Paramètre d'URL   | Description                                    |
| ------------ | --------- | ----------------- | ---------------------------------------------- |
| `Cmd/Ctrl+1` | Single    | (par défaut)      | Afficher le résultat de l'outil sélectionné    |
| `Cmd/Ctrl+2` | Stack     | `?view=stack`     | Tous les résultats empilés verticalement       |
| `Cmd/Ctrl+3` | Files     | `?view=files`     | Explorateur de fichiers de l'espace de travail |
| `Cmd/Ctrl+5` | Scheduler | `?view=scheduler` | Calendrier des tâches planifiées               |
| `Cmd/Ctrl+6` | Wiki      | `?view=wiki`      | Index des pages du wiki                        |
| `Cmd/Ctrl+7` | Skills    | `?view=skills`    | Liste et éditeur de skills                     |
| `Cmd/Ctrl+8` | Roles     | `?view=roles`     | Gestion des rôles                              |

Chaque mode d'affichage est piloté par l'URL : cliquer sur un bouton du lanceur met à jour `?view=`, et atterrir sur une URL avec `?view=wiki` (par exemple) restaure la vue correspondante. La liste des modes d'affichage est définie une seule fois dans `src/utils/canvas/viewMode.ts` — ajouter un nouveau mode est un simple ajout à un tableau.

## Accès à distance

Accédez à votre MulmoClaude en cours d'exécution depuis un téléphone (ou n'importe quel navigateur) : parcourez ses collections, ses feeds et ses vues personnalisées, et démarrez des chats, où que vous soyez. Aucun compte ni serveur distinct à configurer : l'accès est accordé simplement en vous connectant aux **deux** extrémités avec le **même compte Google**.

**Comment se connecter**

1. Sur le bureau, cliquez sur l'icône **phonelink** dans l'en-tête pour ouvrir le popover _Hôte distant_, puis choisissez **Se connecter avec Google**. MulmoClaude se connecte en tant que votre utilisateur Google et ouvre un canal de commandes via Firebase (le projet public partagé [`mulmoserver`](https://mulmoserver.web.app)). L'icône devient verte tant que l'hôte est en ligne.
2. Sur votre téléphone, ouvrez **[https://mulmoserver.web.app](https://mulmoserver.web.app)** et connectez-vous avec le **même compte Google**. L'application web trouve votre hôte en ligne et s'y connecte.

Comme les deux extrémités s'authentifient en tant que même utilisateur Firebase, le téléphone et le bureau ne se rencontrent qu'à l'intérieur de votre propre espace utilisateur — aucun tiers ne peut atteindre votre hôte.

**Firebase et Firestore ne servent que de transport** — un relais pour transmettre les commandes et les réponses entre votre téléphone et votre bureau. Vos données ne sont **jamais stockées ni conservées** sur l'un ou l'autre. Sur l'hôte, seuls vos fichiers locaux de l'espace de travail existent ; tout ce qui doit traverser le canal (comme une pièce jointe transitant par Firebase Storage) est supprimé dès qu'il atteint sa destination.

**Ce que vous pouvez faire depuis le téléphone**

- Parcourir et feuilleter vos **collections** et vos **feeds**.
- Ouvrir des **vues distantes personnalisées** (custom remote views) — des pages adaptées au mobile que Claude crée pour vous. Demandez à Claude de créer une _custom remote view_ (et non une vue personnalisée classique) ; elle peut être en lecture seule ou modifiable.
- **Démarrer un chat** sur l'hôte et joindre des **photos, vidéos ou PDF** depuis le téléphone. Les octets des pièces jointes sont trop volumineux pour le canal de commandes ; ils transitent donc par Firebase Storage ; l'hôte télécharge chaque fichier dans son espace de travail (`data/attachments/`), supprime la copie en transit et transmet le fichier à Claude avec votre message.

Le canal est basé sur des commandes et piloté par l'hôte : le téléphone envoie des requêtes et votre MulmoClaude de bureau y répond. Utilisez **Déconnecter** dans le popover (ou quittez MulmoClaude) pour mettre l'hôte hors ligne.

## Espace de travail

Toutes les données sont stockées sous forme de fichiers en clair dans le répertoire de l'espace de travail, regroupées en quatre groupes sémantiques (#284) :

```
~/mulmoclaude/
  config/              ← settings.json, mcp.json, roles/, helps/
  conversations/       ← chat/, memory.md, summaries/, searches/
  data/                ← wiki/, todos/, calendar/, contacts/, scheduler/,
                         sources/, transports/
  artifacts/           ← charts/, documents/, html/, html-scratch/,
                         images/, news/, spreadsheets/, stories/
```

Consultez [`docs/developer.md`](docs/developer.md#workspace-layout-mulmoclaude) pour la référence complète.

### Listes de tâches

Les listes de tâches se construisent comme des **collections** pilotées par schéma, et non comme une vue dédiée. Demandez à Claude de « configurer une liste de tâches » et il suivra `config/helps/todo-collection.md` pour créer une collection `todos` — avec un enum de statut (`Backlog / Todo / In Progress / Done`), un toggle `done` et des champs optionnels de priorité / date d'échéance, en choisissant automatiquement une vue kanban / tableau / calendrier selon le schéma.

### Planificateur et planification des skills

Le planificateur (`Cmd/Ctrl+5` ou `?view=scheduler`) gère les tâches récurrentes stockées dans `data/scheduler/items.json`. Le cœur du planificateur (`@receptron/task-scheduler`) gère la logique de rattrapage pour les exécutions manquées et prend en charge les planifications `interval`, `daily` et `cron`.

Les skills peuvent être planifiées pour s'exécuter automatiquement en ajoutant un champ `schedule` au frontmatter de SKILL.md :

```yaml
---
description: Morning news digest
schedule: daily 08:00
---
```

Claude enregistrera la skill auprès du planificateur, et elle s'exécutera automatiquement selon le calendrier spécifié.

### Extraction de la mémoire

Claude extrait automatiquement les faits durables de l'utilisateur à partir des conversations de chat et les ajoute à `conversations/memory.md`. Cela s'exécute dans le cadre du passage quotidien du journal — des faits tels que les préférences alimentaires, les habitudes de travail et les préférences d'outils sont distillés à partir des chats récents sans intervention de l'utilisateur. Le fichier de mémoire est toujours chargé dans le contexte de l'agent afin que Claude puisse personnaliser les réponses.

## Paquets du monorepo

Le code partagé est extrait en paquets npm publiables sous `packages/` :

| Paquet                      | Description                                          | Liens                                                                                                   |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@mulmobridge/protocol`     | Types et constantes partagés                         | [npm](https://www.npmjs.com/package/@mulmobridge/protocol) / [source](packages/protocol/)               |
| `@mulmobridge/client`       | Bibliothèque client Socket.io                        | [npm](https://www.npmjs.com/package/@mulmobridge/client) / [source](packages/client/)                   |
| `@mulmobridge/chat-service` | Service de chat côté serveur (fabrique DI)           | [npm](https://www.npmjs.com/package/@mulmobridge/chat-service) / [source](packages/chat-service/)       |
| `@mulmobridge/cli`          | Pont terminal                                        | [npm](https://www.npmjs.com/package/@mulmobridge/cli) / [source](packages/bridges/cli/)                 |
| `@mulmobridge/telegram`     | Pont bot Telegram                                    | [npm](https://www.npmjs.com/package/@mulmobridge/telegram) / [source](packages/bridges/telegram/)       |
| `@mulmobridge/slack`        | Pont bot Slack                                       | [npm](https://www.npmjs.com/package/@mulmobridge/slack) / [source](packages/bridges/slack/)             |
| `@mulmobridge/discord`      | Pont bot Discord                                     | [npm](https://www.npmjs.com/package/@mulmobridge/discord) / [source](packages/bridges/discord/)         |
| `@mulmobridge/line`         | Pont bot LINE                                        | [npm](https://www.npmjs.com/package/@mulmobridge/line) / [source](packages/bridges/line/)               |
| `@mulmobridge/whatsapp`     | Pont WhatsApp                                        | [npm](https://www.npmjs.com/package/@mulmobridge/whatsapp) / [source](packages/bridges/whatsapp/)       |
| `@mulmobridge/matrix`       | Pont Matrix                                          | [npm](https://www.npmjs.com/package/@mulmobridge/matrix) / [source](packages/bridges/matrix/)           |
| `@mulmobridge/irc`          | Pont IRC                                             | [npm](https://www.npmjs.com/package/@mulmobridge/irc) / [source](packages/bridges/irc/)                 |
| `@mulmobridge/mattermost`   | Pont Mattermost                                      | [npm](https://www.npmjs.com/package/@mulmobridge/mattermost) / [source](packages/bridges/mattermost/)   |
| `@mulmobridge/zulip`        | Pont Zulip                                           | [npm](https://www.npmjs.com/package/@mulmobridge/zulip) / [source](packages/bridges/zulip/)             |
| `@mulmobridge/messenger`    | Pont Facebook Messenger                              | [npm](https://www.npmjs.com/package/@mulmobridge/messenger) / [source](packages/bridges/messenger/)     |
| `@mulmobridge/google-chat`  | Pont Google Chat                                     | [npm](https://www.npmjs.com/package/@mulmobridge/google-chat) / [source](packages/bridges/google-chat/) |
| `@mulmobridge/mastodon`     | Pont Mastodon                                        | [npm](https://www.npmjs.com/package/@mulmobridge/mastodon) / [source](packages/bridges/mastodon/)       |
| `@mulmobridge/bluesky`      | Pont Bluesky                                         | [npm](https://www.npmjs.com/package/@mulmobridge/bluesky) / [source](packages/bridges/bluesky/)         |
| `@mulmobridge/chatwork`     | Pont Chatwork (messagerie d'entreprise japonaise)    | [npm](https://www.npmjs.com/package/@mulmobridge/chatwork) / [source](packages/bridges/chatwork/)       |
| `@mulmobridge/xmpp`         | Pont XMPP / Jabber                                   | [npm](https://www.npmjs.com/package/@mulmobridge/xmpp) / [source](packages/bridges/xmpp/)               |
| `@mulmobridge/rocketchat`   | Pont Rocket.Chat                                     | [npm](https://www.npmjs.com/package/@mulmobridge/rocketchat) / [source](packages/bridges/rocketchat/)   |
| `@mulmobridge/signal`       | Pont Signal (via signal-cli-rest-api)                | [npm](https://www.npmjs.com/package/@mulmobridge/signal) / [source](packages/bridges/signal/)           |
| `@mulmobridge/teams`        | Pont Microsoft Teams (Bot Framework)                 | [npm](https://www.npmjs.com/package/@mulmobridge/teams) / [source](packages/bridges/teams/)             |
| `@mulmobridge/line-works`   | Pont LINE Works (LINE entreprise)                    | [npm](https://www.npmjs.com/package/@mulmobridge/line-works) / [source](packages/bridges/line-works/)   |
| `@mulmobridge/nostr`        | Pont DM chiffrés Nostr                               | [npm](https://www.npmjs.com/package/@mulmobridge/nostr) / [source](packages/bridges/nostr/)             |
| `@mulmobridge/viber`        | Pont Viber                                           | [npm](https://www.npmjs.com/package/@mulmobridge/viber) / [source](packages/bridges/viber/)             |
| `@mulmobridge/webhook`      | Pont webhook HTTP générique (glue pour développeurs) | [npm](https://www.npmjs.com/package/@mulmobridge/webhook) / [source](packages/bridges/webhook/)         |
| `@mulmobridge/twilio-sms`   | SMS via Twilio                                       | [npm](https://www.npmjs.com/package/@mulmobridge/twilio-sms) / [source](packages/bridges/twilio-sms/)   |
| `@mulmobridge/email`        | Pont Email (IMAP + SMTP)                             | [npm](https://www.npmjs.com/package/@mulmobridge/email) / [source](packages/bridges/email/)             |
| `@mulmobridge/mock-server`  | Serveur simulé pour les tests                        | [npm](https://www.npmjs.com/package/@mulmobridge/mock-server) / [source](packages/mock-server/)         |
| `@receptron/task-scheduler` | Planificateur de tâches persistant                   | [npm](https://www.npmjs.com/package/@receptron/task-scheduler) / [source](packages/scheduler/)          |

N'importe qui peut écrire un pont dans n'importe quel langage — il suffit de parler le protocole socket.io documenté dans [`docs/bridge-protocol.md`](docs/bridge-protocol.md).

## Documentation

La documentation complète se trouve dans [`docs/`](docs/README.md). Voici les points d'entrée clés :

### Pour les utilisateurs

| Guide                                                                                                      | Description                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [MulmoBridge Guide](docs/mulmobridge-guide.en.md) / [日本語](docs/mulmobridge-guide.md)                    | Connectez des applications de messagerie (Telegram, Slack, LINE, etc.) à votre PC à domicile |
| [Scheduler Guide](docs/scheduler-guide.en.md) / [日本語](docs/scheduler-guide.md)                          | Tâches automatisées récurrentes                                                              |
| [Obsidian Integration](docs/tips/obsidian.en.md) / [日本語](docs/tips/obsidian.md)                         | Utilisez Obsidian pour parcourir le wiki et les documents de MulmoClaude                     |
| [Telegram Setup](docs/message_apps/telegram/README.md) / [日本語](docs/message_apps/telegram/README.ja.md) | Configuration pas à pas du Bot Telegram                                                      |
| [LINE Setup](docs/message_apps/line/README.md) / [日本語](docs/message_apps/line/README.ja.md)             | Configuration pas à pas du Bot LINE                                                          |

### Pour les développeurs

| Guide                                              | Description                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| [Developer Guide](docs/developer.md)               | Variables d'environnement, scripts, structure de l'espace de travail, CI   |
| [Bridge Protocol](docs/bridge-protocol.md)         | Spécification au niveau du fil pour écrire de nouveaux ponts de messagerie |
| [Sandbox Credentials](docs/sandbox-credentials.md) | Transfert d'identifiants du bac à sable Docker (SSH, GitHub CLI)           |
| [Logging](docs/logging.md)                         | Niveaux de log, formats, rotation des fichiers                             |
| [Troubleshooting](docs/troubleshooting.md)         | Problèmes d'installation — interface cassée, `404` sur `dist/*`, Windows/OneDrive, `401` après redémarrage, avertissements au démarrage |
| [CHANGELOG](docs/CHANGELOG.md)                     | Historique des versions                                                    |

## Licence

MIT — voir [LICENSE](LICENSE).
