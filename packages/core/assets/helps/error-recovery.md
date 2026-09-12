# Error recovery — when a tool call fails, or the user says something is broken

This is the lookup the agent reads BEFORE asking the user a clarifying
question or giving up on a failing tool call. Each section is keyed by
the error message you'd see in tool output, with the cause and the
documented fix.

It has a second entry point. When the **user** reports that MulmoClaude is
broken / weird / not working — nothing has failed in tool output, they are
just describing a symptom — start at **§ The user says MulmoClaude is
broken** below instead of scanning the error-keyed sections.

Cite the section you used in your reply so the user can follow up
(e.g. "Per `config/helps/error-recovery.md` § gh-auth / SSH …").

If no section here matches, list the workspace's other help files
(`ls config/helps/`) and Read whichever name best matches the failing
area (`sandbox.md`, `github.md`, `collection-skills.md`, etc.) before
falling back to asking the user.

## The user says MulmoClaude is broken

**The goal is that the user ends up unblocked, not that an issue gets filed.**
An issue is what's left after the first three steps fail to explain the
behaviour. Work them in order and stop the moment the user is unblocked.

Rules that hold in every step:

- **Never assert "that's by design" from memory.** Say it only with a reason
  attached: a config key, a help page, an implementation file.
  `bug-report-faq.md` is an index of where to look — it deliberately contains
  no values.
- **Read the real thing.** Current values come from the workspace's
  `config/settings.json` or `GET /api/health`, never from recollection.
- **"I don't know" is an allowed answer.** If a step can't decide, say so and
  go to the next one. Never close the conversation by guessing.
- **Nothing leaves the machine before the user has seen it in full** and agreed.
- Reply in the language the user writes in.

### Step 1 — Hear the symptom (collect nothing yet)

Call `presentForm` once with the questions below rather than asking in prose —
a user who is already frustrated should be clicking, not composing.

- **What kind** — display looks wrong / input doesn't work / the agent won't
  answer / a tool keeps failing / phone or remote features / something else
- **Where** — chat / a collection / the wiki / files / settings / the phone app
- **How often** — every time / sometimes / once
- **Since when** — after an update / it always did this / not sure
- **What did you expect, and what happened instead?** (free text, required —
  these two sentences are what the next step is judged against)

### Step 2 — Is it configuration, or by design? (this is the actual job)

1. Read `config/helps/bug-report-faq.md` and find the entry closest to the
   symptom.
2. Follow its pointers to the **real values** — `config/settings.json` for a
   `configKey`, the named help page for a `help`. A setting absent from the file
   is at its default, which is the answer to most entries there.
3. If that explains the gap between expected and actual, **say why, show the
   fix, and stop.** Cite what you checked.
4. If nothing explains it, go to Step 3. Do not stretch a FAQ entry to cover a
   symptom it doesn't cover.

### Step 3 — Is it already known?

Search the existing issues before opening anything:

```bash
gh issue list --repo receptron/mulmoclaude --state all --limit 20 --search "<symptom keywords>"
```

`gh` is **not available by default** — the agent runs in a credential-free
sandbox (see § gh / git / SSH errors inside the sandbox). Don't spend turns
fighting it: hand the user the search URL instead.

`https://github.com/receptron/mulmoclaude/issues?q=voice+input+disabled` — build
the `q=` value percent-encoded (space → `+` or `%20`, `#` → `%23`), or the link
breaks on the first symptom that contains one.

- **Closed and fixed** → compare their version against the release that fixed
  it. If they're simply behind, tell them to update and stop.
- **Open** → do not open a second one. Offer to add this user's environment and
  repro steps as a comment; a second reproduction is worth more than a duplicate.
- **Nothing found** → Step 4.

### Step 4 — File it

Only now collect details. Fetch the environment report from the server, from the
workspace root:

```bash
curl -s -H "Authorization: Bearer $(cat .session-token)" \
  "http://${MULMOCLAUDE_HOST:-127.0.0.1}:$(cat .server-port)/api/diagnostics/report"
```

Three parts of that command are load-bearing, and dropping any one returns
nothing useful:

- **The bearer header.** Every `/api/*` route requires it; without it the reply
  is a 401, not a report. The token is regenerated each startup and lives in
  `.session-token` at the workspace root.
- **`$MULMOCLAUDE_HOST`.** In the default Docker sandbox `localhost` is the
  container, not the machine running the server — the variable is set to
  `host.docker.internal` there and unset on a host-mode run, hence the fallback.
- **`.server-port`.** The port is chosen at startup; there is no fixed default
  to hardcode.

Keep the token inside the command substitution: never echo it, never let it
reach the report body, and if you quote the command in the issue, quote it in
the `$(cat …)` form above rather than with the value expanded.

**The server does the redaction, not you.** It prints values only for
allow-listed settings and withholds everything else, including the plaintext
Google Maps key and every MCP server's `env` / `headers`. Paste what it returns
verbatim — do not "help" by adding values you read elsewhere, and do not
re-type a secret you happened to see in a file.

Ask the user for what the host cannot see: the browser and its version, any red
errors in the browser console, and a screenshot if the symptom is visual. Say
before they attach one that a screenshot can carry file paths and chat text.

Report body:

```markdown
## What happened

## What I expected

## Steps to reproduce

1.

## Environment

(paste the diagnostics report here)

## Attachments
```

Show the whole thing, get an explicit yes, then post it — `gh issue create
--repo receptron/mulmoclaude --title "<title>" --body-file <file>` when `gh`
works, otherwise print the markdown for copy-paste plus
`https://github.com/receptron/mulmoclaude/issues/new`.

### When Step 2 resolved it

A question that took an agent to answer is a signal about the product: the UI
failed to say something. Offer to post it as an issue titled with the question
as the user asked it, noting what the answer turned out to be and **where it was
checked**. Open the body with a line saying the answer came from this lookup and
is awaiting maintainer review — it is a draft, not documentation. Never edit
`bug-report-faq.md` yourself.

## gh / git / SSH errors inside the sandbox

### Symptoms

- `gh: To authenticate, please run gh auth login`
- `git@github.com: Permission denied (publickey)`
- `Could not resolve host: github.com`
- `Permission denied (publickey)` on `git push` / `git clone <ssh-url>`
- `fatal: Could not read from remote repository`

### Cause

The Claude Code agent runs inside a credential-free Docker sandbox by
default. The host's SSH agent and `gh` config aren't exposed unless the
user opts them in.

### Fix

Tell the user to enable the two opt-in mounts on the next agent spawn
(see also `config/helps/sandbox.md` for the full contract):

```bash
# Forward the host's SSH agent into the container.
# Private keys stay on the host; only the signing oracle is exposed.
SANDBOX_FORWARD_SSH_AGENT=1 \
# Mount allowlisted config files/dirs read-only — including ~/.config/gh.
SANDBOX_MOUNT_CONFIGS=gh \
  yarn dev   # or: npx mulmoclaude
```

Equivalent CLI flags: `--sandbox-forward-ssh-agent --sandbox-mount-configs=gh`.

After restart, inside the agent's first tool turn verify:

```bash
ssh-add -l                      # should list at least one key
gh auth status                  # should report logged in
```

If `ssh-add -l` fails, the host's SSH agent isn't running — tell the
user to start it (`ssh-add ~/.ssh/id_*` on macOS / Linux). If
`gh auth status` fails, the user needs to run `gh auth login` on the
host first (host config is mounted read-only into the sandbox).

### When neither helps

The sandbox itself can be turned off for the session with
`DISABLE_SANDBOX=1 yarn dev` / `--disable-sandbox`. The agent then
inherits the user's full environment. Recommend this only when the
credential mount approach didn't resolve the issue — the sandbox is
the safer default.

## Collection registry — Contribute / Discover failures

### Symptoms

- Contribute flow: `gh pr create` fails, `git push` rejected, or the
  registry clone fails inside `github/`.
- Discover tab loads no entries, or one registry's cards are missing.

### Cause + fix

For the Contribute side, the underlying issue is almost always
sandbox credentials — see the gh/git/SSH section above before anything
else.

For Discover, multi-registry config lives at
`config/collections-registries.json`. A malformed entry there is
silently dropped; check the server log for
`[collections-registry] registry config entry rejected`. The file
format and validation rules are documented in
`config/helps/collection-skills.md` (Contribute bundle layout) and the
shipped registry repo's README. Common rejections:

- URL not HTTPS, or includes embedded credentials.
- `rawBaseUrl` contains a `?` query or `#` fragment.
- `name` reuses the reserved value `official`.
- `name` doesn't match `[A-Za-z0-9][A-Za-z0-9_-]{0,31}`.

## A collection's icon shows up as letters, or smears over its neighbours

### Symptoms

- A collection / feed / pinned shortcut draws its icon NAME as text
  (`podcasts`, or a fragment like `_A__C`) instead of a glyph.
- The text spills out of its square and overlaps the buttons next to it
  in the launcher bar.

### Cause + fix

`schema.icon` was set to something the Material Symbols font has no
ligature for. The font matches icons by LIGATURE, so an unknown value
is simply laid out as ordinary text.

Valid names are lowercase letters, digits and underscores only —
`podcasts`, `rss_feed`, `menu_book`, `3d_rotation`. Capitals, spaces
and hyphens never match (`Podcasts` and `menu-book` are the usual
typos). Look the name up in the Material Symbols set before writing it;
do not invent one.

An **emoji is a valid alternative** and is often the better choice: it
is in colour and stands out among the monochrome glyphs, which is the
point when several collections would otherwise share a look-alike icon
(`podcasts` / `rss_feed` / `menu_book`). Set `"icon": "🎙️"` the same way you
would set a name. Only the first GRAPHEME is drawn — one emoji, whatever
number of code points it is built from (a variation selector, a skin tone, a
ZWJ family) — so write exactly one glyph and nothing after it.

If the smearing persists after the value is corrected, the surface
drawing it is bypassing `IconGlyph`
(`@mulmoclaude/core/plugin-vue`) — every schema-authored icon must go
through it rather than into a bare
`<span class="material-symbols-outlined">`.

## A hand-placed custom role never appears in the list

### Symptoms

- The user put a file in `config/roles/` themselves (not via Settings →
  Roles / `manageRoles`) and the role is absent from the role list.
- Nothing failed in tool output — `manageRoles` with `action: "list"`
  simply doesn't include it.

### Cause + fix

The loader reads **`config/roles/<id>.json` only**, and a file it cannot
use is skipped rather than fatal — so one broken file can't take the
whole list down. The reason is in the server log as a `[roles]` warning
naming the file:

- `role file is not valid JSON, skipping` — trailing comma, single
  quotes, unquoted key.
- `role file does not match the role schema, skipping` — the `issues`
  field names each field, e.g. `icon: Invalid input: expected string,
received undefined`. All of `id`, `name`, `icon`, `prompt`,
  `availablePlugins` are required; `availablePlugins` must be an array
  even for one entry.
- `role file is empty, skipping` — zero-length or whitespace only.
- `role file could not be read, skipping` — permissions, or the path is
  a directory.
- `role file disappeared while loading, skipping` — the file was renamed
  or deleted while the list was being read, or it is a broken symlink.
  Re-running the load is enough if the file is there now.
- `ignoring entries that are not .json files` — a `.md` / `.jsonc` /
  `.json.txt` file is never read as a role.

Ask the user for that warning line (or the file's contents) rather than
guessing which of the six it is. Writing the role through
`manageRoles` instead sidesteps all of them — it serializes the role, so
the file is always valid.

## A custom role is in the list but delete / update says it doesn't exist

### Symptoms

- `manageRoles` with `action: "list"` includes the role, but `delete` or
  `update` on that same id returns `Role '<id>' not found.`
- Or: `Cannot delete built-in roles.` for a role the user created.
- Or: the user edited a role and the change had no effect, because
  another file with the same id is the one that id resolves to.

### Cause + fix

The list shows the `id` from **inside** the file, while delete / update
address the role by its **file name** — so `config/roles/designer.json`
containing `"id": "myrole"` is listed as `myrole` but delete / update
only accept `designer`. Two `[roles]` warnings in the server log name
it:

- `role id does not match its file name` — `fileName` and `id` are both in
  the warning. Which repair is safe depends on which side is malformed:
  role ids must match `[a-zA-Z0-9_-]+`, and nothing enforces that on a
  hand-placed file. **Follow the variant the warning gives you** rather
  than picking a repair yourself — the wrong one can leave the role
  reachable under no name at all:
  - no extra clause — both names are usable. Rename the file to
    `<id>.json`, or change the `id` to the file's own name. Until then the
    **file name** is a working handle: `delete <file name>` removes it.
  - `… the file name is not a usable role id either` — e.g.
    `my role.json`, rejected as `Invalid role id 'my role'.` Neither name
    reaches the role. Renaming is the only fix.
  - `… the id is not a usable role id` — the reverse, e.g. `"id": "my
role"` in `designer.json`. `delete designer` still works, and renaming
    to `my role.json` would take that away. Change the `id`.
  - `… neither is a usable role id` — pick one id that matches the pattern
    and use it for the file name and the `id` together.
  - an inner `id` equal to a built-in role's id — the file also shadows
    that built-in, and `delete` on the listed id refuses it as built-in.
    Renaming is the way out.
- `more than one role file declares the same id` — both files load and
  both appear in the list; `used` is the one that id resolves to
  (readdir order, not a choice the user made) and `ignored` lists the
  rest. Give each role a distinct id, or remove the extra file.

Ask the user for the warning line rather than guessing which of the two
it is. Both only happen to hand-placed or hand-renamed files:
`manageRoles` writes `config/roles/<role.id>.json`, so file name and
`id` always agree.

## Marp slide PDF — empty / image / font issues

### Symptoms

- PDF export of a Marp deck produces tofu (□□□) for Japanese / CJK text.
- Inline images in a slide are missing from the PDF.
- A custom Marp `theme: <name>` is ignored.

### Fix

CJK fonts (Hiragino on macOS, Yu Gothic / Meiryo on Windows, Noto Sans
CJK on Linux) need to exist on the **host running the server**, not
in the sandbox (PDF render happens server-side via puppeteer). On
Linux: `sudo apt-get install fonts-noto-cjk`. Docker host:
`apt-get install -y fonts-noto-cjk` in the production Dockerfile.

Inline images missing from the PDF: paths must be relative to the
`.md` file, NOT absolute or workspace-rooted. See the "Image
references in markdown / HTML" section of the system prompt for the
rule.

Custom theme ignored: themes live in `~/mulmoclaude/config/marp-themes/<name>.css`.
The filename (sans `.css`) is the theme slug; only `[A-Za-z0-9_-]` is
allowed. Reload the browser tab after adding a theme — preview caches
per session.

## MulmoScript render — "generate error" from image / movie / audio generation

### Symptoms

- A beat render, character image, movie, or PDF generation fails with a
  message like `generateReferenceImage: generate error: key=<name>` or
  `Image was not generated`.
- `autoGenerateMovie` leaves a `<script>.json.error.txt` sidecar next to
  the story file with a similar message.

### Cause

Generation providers are chosen **per script**: `imageParams.provider`,
`movieParams.provider`, and `speechParams.speakers.<name>.provider`. The
underlying failure is usually a missing/invalid API key for whichever
provider the script names (`openai` → `OPENAI_API_KEY`, `google` /
`gemini` → `GEMINI_API_KEY`, `replicate` → `REPLICATE_API_TOKEN`), or a
quota / moderation rejection from that provider.

### Fix

The server appends the provider's own error to the message (e.g.
`… — 401 Incorrect API key provided`) and logs it under the
`mulmocast` prefix — read that detail first. Then either add the
missing key to `.env` (restart the server) or rewrite the script's
`imageParams` / `movieParams` / speaker providers to ones that have
keys configured. Don't retry the render unchanged — the same provider
will fail the same way.

## MulmoScript narration — wrong voice, ignored direction, or every beat re-recorded

### Symptoms

- A non-default language (`speechParams.speakers.<name>.lang.<code>`) renders
  in a different voice, or fails on a missing `OPENAI_API_KEY` even though the
  script names `gemini` everywhere.
- `speechOptions.instruction` or `speed` has no audible effect on the narration.
- A small edit to a speaker re-generates audio for **every** beat, including the
  ones whose text never changed.

### Cause

Speech settings resolve through silent fallbacks — the schema does not reject a
missing field, it fills one in:

- A `lang` entry **replaces** the whole speaker; it does not extend it. Whatever
  the entry omits falls back to the schema and provider defaults, so one holding
  only `voiceId` loses `provider` (which then resolves to `openai`), `model`, and
  `speechOptions`.
- `instruction` is dropped by the `google` provider unless the speaker also sets
  a `model`; `speed` is ignored by `gemini` altogether.
- Each beat's audio file is cached under a hash of that beat's `text` plus the
  speaker's `voiceId` + `provider` + `model` + `speechOptions`. Editing the
  speaker is a new cache key for every beat that speaks through it — the whole
  script when there is one speaker — so it is re-recorded and re-billed.

### Fix

Repeat every field the parent speaker sets — `provider` above all — inside each
`lang` entry. Express pacing for Gemini through `instruction` rather than
`speed`. Settle voice, model, and delivery **before** the first render — and when
a change is genuinely wanted, say up front that every beat of that speaker
re-records, rather than letting the bill surprise the user. Field-by-field
reference: `config/helps/mulmoscript.md` → speechParams.

## Build / yarn workspace ordering

### Symptoms

- `yarn dev` fails on a fresh clone with
  `Cannot find module '@mulmoclaude/<x>-plugin/server'` or similar.
- A workspace package's `dist/` is missing on first run.

### Fix

```bash
yarn build:packages   # builds every shared workspace package in tier order
yarn dev              # then the dev server picks them up
```

If a specific package keeps failing, build just it:
`yarn workspace @mulmoclaude/<name> run build`. The build pipeline
runs plugins before services so cross-package imports resolve cold.

## Plugin runtime — install / drift

### Symptoms

- A runtime plugin shown in `/skills` doesn't load, or its routes 404.
- After upgrading the plugin host, a previously-installed plugin
  reports a peer-dependency mismatch (e.g. `gui-chat-protocol`
  version skew).

### Fix

Runtime plugins are installed via tgz under `~/mulmoclaude/plugins/`
with a ledger at `plugins/plugins.json`. Reinstall the failing
plugin via the `/skills` UI to refresh both the tgz and the ledger.
A version skew on a peer dep means the plugin was built against an
older host — bump the plugin via the Discover tab's update flow.

## A collection you just authored never appears — you wrote under `data/skills/`

You created `data/skills/<slug>/schema.json` + `SKILL.md`, got no error from
any tool, and the collection is nowhere: not at `/collections/<slug>`, not in
`manageCollection` `getOntology`, not in the sidebar. Nothing is logged,
because nothing failed — the files are exactly where you put them.

### Why

`data/skills/` is a STAGING tree, and it only works where a host-side
skill-bridge hook mirrors it into `.claude/skills/<slug>/`. Discovery scans
`.claude/skills` and nothing else. In a managed workspace the hook exists, so
authoring under `data/skills/` is right (and necessary — `.claude/` is behind a
permission gate the GUI cannot answer). In a plain project folder there is no
gate and no hook, so a `data/skills/` tree is never mirrored and never read.

Two symptoms confirm it:

- `.claude/skills/<slug>/` does not exist, or is older than what you wrote;
- a `data/skills/<slug>/` tree exists that nothing references.

### Fix

Write the skill directly into `<root>/.claude/skills/<slug>/` —
`schema.json`, `SKILL.md`, `templates/*.md`, and any `views/*.html` — then
remove the stray `data/skills/<slug>/` tree. Leaving it is not merely untidy:
a stale file there can shadow the real skill's file of the same name on later
reads.

Then re-read the authoring reference before writing more: call
`manageCollection` `schemaDocs`. It serves the variant that matches THIS root,
so the instructions you get name the location that actually works here. If the
guide it returns says `data/skills/`, this root does have a bridge and the
problem is something else — check that `schema.json` passed validation (a
schema that fails is silently skipped at discovery).

## dataSource (CSV) collection reads fail — "DuckDB is unavailable on this host"

A collection whose schema declares `dataSource` (external CSV) reads its rows
through `@duckdb/node-api`, a NATIVE module with per-platform prebuilt
bindings. When the binding is missing or fails to load, ONLY dataSource
collections break (every file-backed collection keeps working) and reads
fail with `DuckDB is unavailable on this host (@duckdb/node-api failed to
load: …)`.

Diagnosis + fixes, in order:

1. **Reinstall dependencies** — `yarn install` at the app root. The usual
   cause is an install that skipped the platform package
   (`@duckdb/node-bindings-<platform>-<arch>`), e.g. after copying
   `node_modules` between machines or architectures (an arm64 → x64 Docker
   volume mount does exactly this).
2. **Check the platform is supported** — `ls node_modules/@duckdb/ | cat`.
   You should see a `node-bindings-<your platform>` package. If DuckDB ships
   no prebuilt binding for the host (rare: musl/alpine, exotic arch), there
   is no local fix — tell the user dataSource collections need a supported
   platform (glibc Linux x64/arm64, macOS, Windows) and that their other
   collections are unaffected.
3. **Docker**: make sure the image installs dependencies INSIDE the
   container (matching libc/arch) rather than bind-mounting a host
   `node_modules`.

Related, not an error: a dataSource CSV in Shift_JIS / UTF-16 is decoded
automatically to a cache copy under the OS temp dir — never "fix" the
user's file by re-encoding it.

## storage (sqlite) collection fails — "sqlite storage needs the node:sqlite module"

A collection whose schema declares `storage: { type: "sqlite", path: … }`
keeps its records in a single SQLite database file, read/written through
Node's BUILT-IN `node:sqlite` module — no npm dependency. That module
exists only in **Node.js >= 22.5**, while the app itself runs on >= 20.12,
so on an older runtime ONLY sqlite-backed collections break (file and
dataSource collections keep working) and every operation fails with
`sqlite storage needs the node:sqlite module (Node.js >= 22.5) — this
runtime cannot load it`.

Diagnosis + fixes, in order:

1. **Check the Node version** — `node --version`. Below 22.5 there is no
   local fix except upgrading Node; tell the user which version they run
   and that their other collections are unaffected.
2. **`ExperimentalWarning: SQLite is an experimental feature`** printed
   once on first use is EXPECTED on Node 22.x — it is a warning, not an
   error; do not chase it.
3. **Do not "repair" by converting the collection to `dataPath`** unless
   the user asks — the records live inside the `.db` file, not as
   `<id>.json` files; a schema flip alone would make the collection look
   empty, not migrate it.

Known limits of sqlite storage (by design, not bugs to fix in place):
a db row so corrupt the backend can't parse it is skipped silently (the
Repair pass reports schema violations by record id, but has no
"malformed file" classification), and the completion/spawn watcher
reconciles the WHOLE collection per db change (no per-record events).

## A record the user edited came back with the source's value

### Symptoms

Nothing fails — the user reports it. Any of:

- A Google Calendar collection record they edited shows Google's value
  again after a sync.
- A feed record lost the column they had added beside it, or the whole
  record disappeared once the item aged past `ingest.maxItems`.
- The edit is simply gone, and no conflict was ever reported.

### Cause

Records are written WHOLE (`writeItem`), so anything that mirrors a
remote source into a collection has to lay its values OVER the stored
record rather than replace it — and has to refuse when the record holds
an edit the source has not seen. Four separate places got that wrong:

- `#2683` — a calendar collection without `autoPush` was never in the
  pull's protected set at all.
- `#2684` — the protected set was a snapshot taken when the push
  finished, so an edit made while the window was in flight (minutes of
  it, on a full re-walk) was invisible to it.
- `#2688` — a cancellation in Google deleted the record without asking
  whether it held an unsent edit.
- `#2696` — the feeds ingest replaced the record whole, and the
  `maxItems` prune deleted annotated records once they aged out.

### Fix

All four are fixed as of `@mulmoclaude/core` 1.13.0. **Check the host's
version first** — if it is older, that is the whole answer.

If it happens on 1.13.0 or later, it is a new bug, not one of these:
capture which collection, whether it declares `googleCalendar` or
`ingest`, and what the record looked like before and after. Do NOT
suggest re-editing and hoping — the point of these fixes is that the
loss is no longer silent.

## A calendar conflict is reported on every Push and will not clear

### Symptoms

Push reports a conflict for a record that already matches Google. It
comes back on every attempt; nothing the user does in the record clears
it.

### Cause

The conflict check compares Google against the BASELINE in
`<workspace>/data/calendar/.push-state.json`, not against the record.
A baseline older than both sides reports a conflict forever.

Before `#2679` that happened whenever two hosts pointed at the same
workspace: both read the same snapshot and the later write dropped the
earlier one's entry. The state files are now serialised across
processes with a lock file.

**It can still happen when the workspace lives in a sync folder**
(Dropbox, iCloud, Google Drive). Exclusive file creation gives no
exclusion there — the file is replicated after the fact, so both hosts
believe they hold the lock. No mechanism in the app can fix that.

### Fix

Move the workspace onto a real filesystem. A network mount is fine
(`O_EXCL` is atomic on NFSv3+); a consumer sync folder is not.

Nothing is lost while it persists: the push REFUSES rather than
overwrites, which is exactly what the conflict report means. If the
workspace is already on a real filesystem and a conflict still will not
clear, that is a new bug — report it with the calendar id and the
record.

## A calendar collection only ever holds a handful of records

### Symptoms

A `googleCalendar` collection sits at a small number of records (0, 1,
a couple of dozen) instead of the calendar's history. Sync reports
success with **no error**, and pressing it again adds nothing. Only
events created or edited AFTER the collection existed keep arriving.

### Cause

A Google sync token is keyed by `calendarId` alone, so it is shared by
every consumer of that calendar — the `google` tool's `calendarSync`,
and every collection bound to it. Before `#2850` a fresh collection
resumed from whatever cursor was already stored, so its "first sync"
was a DELTA of a window it had never received. Two ways in: the user
(or you) ran `google` `kind: "calendarSync"` first, or another
collection on the same calendar had already synced.

Fixed in `@mulmoclaude/core` 3.4.0: a collection now records its own
backfill beside its records (`<dataPath>/.calendar-sync.json`) and the
sync walks the whole calendar while any collection still lacks one. The
`google` tool keeps a separate cursor.

### Fix

On a host with the fix, delete `<dataPath>/.calendar-sync.json` (or the
records themselves) and press Sync — the walk starts over. On an older
host, delete `<workspace>/data/calendar/.sync-state.json` to force a
full re-walk for every collection on that calendar.

Do NOT tell the user to recreate the collection: deleting the skill
files by hand does not clear the shared cursor, which is why the
original reporter hit this six times in a row.

## Sync says only part of the calendar was copied

### Symptoms

Sync reports `Google returned more pages of events than one sync pass
walks`. The collection holds real records, but not all of them, and the
message returns on every attempt.

### Cause

One sync pass walks a bounded number of pages, and Google returned more
than that. Any calendar big enough in Google's own paging terms reaches
it — Google states a page may hold fewer events than asked for, "or none
at all", so page count does not track event count.

The common cause by far is recurring expansion: with `singleEvents=true`
and no date window, a recurring event with **no end date** is expanded
decades into the future, and one such series can fill the entire walk
before any other event is reached. Check that first, but do not assume
it is the only way in.

Before `#2850` this was silent — the partial copy read as a completed
sync.

### Fix

Give every recurring event with no end date a finite end date in Google
Calendar, then Sync again. Ask the user to check for "repeats forever"
series; a single one is enough to cause this. If there are none and the
message persists, the calendar is simply larger than one pass — report
it, since raising the guard is a code change.

Nothing already synced is lost while it persists: the records that did
arrive are written and keep their baseline, and the sync withholds the
backfill marker rather than claiming the calendar is fully copied.

## `proceeding without the calendar state lock` in the logs

### Symptoms

A `google` warning naming a `.lock` path, during a calendar sync.

### Cause

The lock guards one read-modify-write of a calendar state file, and it
fails OPEN: a host that cannot take it does its work anyway, because
the lock removes a race rather than being a precondition for syncing
correctly.

A single occurrence is normal — another host held the file for the few
milliseconds the mutation takes.

### Fix

Nothing, if it is occasional. If it is constant, either another host is
hammering the same workspace, or the lock file cannot be created at all
(a read-only mount, a missing `data/calendar` directory, a full disk) —
check those before treating it as a calendar problem.

## Fallback

If none of the above matches the failing tool output:

1. `ls config/helps/` to see every shipped help file.
2. Pick the file whose name most closely matches the failing area
   (`sandbox.md`, `github.md`, `feeds.md`, `presentation-deck.md`,
   `mulmoscript.md`, `spreadsheet.md`, etc.) and Read it.
3. If you find a fix there, apply it and cite the help by path in
   your reply.
4. If nothing fits, surface the raw error to the user and say
   "no documented fix found in `config/helps/` — could you share more
   context so we can resolve this together?" rather than silently
   guessing or retrying the same command.

## When you discover a new common error

If you resolve a new class of error that other users are likely to
hit, suggest to the user that we extend this file. Don't edit it
yourself — additions to `config/helps/error-recovery.md` are managed
by the project maintainers so the canonical copy in
`packages/core/assets/helps/error-recovery.md` and the installed copy
stay in sync.

## Sandbox MCP server dies at load — `Cannot find module '@…/…'`

### Symptoms

- Chatting fails before any tool runs, with:
  `Error: MCP tool mcp__mulmoclaude__handlePermission (passed via --permission-prompt-tool) not found.`
- Or, in the server log: `[agent-stderr] Error: Cannot find module '@mulmobridge/protocol'`
  (or `@mulmoclaude/chart-plugin`, `@gui-chat-plugin/camera`, …) followed by a `Require stack:`
  listing `/app/server/agent/mcp-server.ts`.
- Sandbox (Docker) mode only. The broker dies **permanently** — it fails on every manual retry
  too (contrast the transient scheduler race below, which succeeds on a manual re-run).
- Three causes share this message. Only this one names a missing module in the log; if the log
  has no `Cannot find module`, check the scheduler race and the frozen-CLI section below.

### Cause

The MCP child resolves its imports against `/app/node_modules` plus the `/app/pkg_modules`
fallback on `NODE_PATH`. It dies at load when a package it imports is reachable from neither. Two
layouts cause that:

1. **Windows source checkout.** `yarn` links workspace packages into `node_modules/` as **NTFS
   junctions**; their absolute Windows target (`C:\Users\…`) does not exist in the Linux container,
   so every junction dangles. `server/agent/config.ts` bind-mounts a junction-free copy of each
   workspace package at `/app/pkg_modules/<name>`; a package missing from that list is invisible.
2. **npx install with nested `node_modules`.** npm sometimes places a dep in the nested
   `<packageRoot>/node_modules` (a version conflict, or a half-deduped npx cache from repeated
   overwrite-updates) instead of hoisting it to `<projectRoot>/node_modules`. Only the latter is
   mounted to `/app/node_modules`, so the nested dep is invisible.

Either way the child dies before the MCP handshake, so the agent loses **every** MCP tool at once —
`handlePermission` included, which is why the CLI complains about the permission-prompt tool rather
than about the missing module.

### Fix

Both layouts are handled automatically: the Windows case mounts every workspace scope, and the npx
case mounts the nested `<packageRoot>/node_modules` onto `/app/pkg_modules`. If you see this anyway:

```bash
# Check the SHIPPED mount list, not a hand-mounted copy: does the package the
# child failed on appear in what workspaceModuleMounts() actually produces?
node_modules/.bin/tsx test/sandbox-repro/print-mcp-container-spec.ts \
  | grep pkg_modules/<name>       # <name> e.g. @mulmobridge/protocol

# The workspace dists must exist — production ships built output.
yarn build:packages:dev
```

A stale `dist/` looks identical from the outside: the mount is there, but its `exports` target is
absent. Rebuild before suspecting the mounts.

For an **npx** install specifically, the quickest user-side unblock is to clear the npx cache so
the next launch installs a clean, fully-hoisted tree:

```bash
rm -rf ~/.npm/_npx        # then re-run:
npx mulmoclaude@latest
```

## Scheduled run fails once with `handlePermission not found`, but works on a manual retry

### Symptoms

- A scheduled skill / user task fails with the SAME
  `MCP tool mcp__mulmoclaude__handlePermission ... not found` message — but running the identical
  skill by hand immediately afterwards succeeds.
- More frequent when several tasks are scheduled for the same minute (e.g. multiple 20:00 UTC
  jobs). The failed run's transcript is tiny (a few hundred bytes to a few KB) and its recorded
  duration is only milliseconds.

### Cause

This is a transient STARTUP RACE, not the permanent load failure above. Each scheduled chat spawns
its own `mulmoclaude` MCP broker; when many chats launch in the same instant the broker boots under
contention and can connect a moment after the agent's first tool call, so the permission-prompt
tool is briefly absent. The broker connects seconds later — which is why a manual re-run works.

The scheduler now staggers same-minute firings by a second each to reduce this contention (#2057),
so it should be rare. It is NOT a module-resolution problem — the mounts / `dist` are fine.

### Fix

Just re-run the task. If it recurs often on a busy schedule, spread the tasks across different
minutes rather than stacking them on the same one.

If a manual re-run fails too, it isn't this race — check the frozen-CLI section below.

### Regression coverage

`.github/workflows/docker_sandbox_windows.yaml` boots the real `mcp-server.ts` inside a Linux
container from a Windows host (WSL2 + native `dockerd`), with the same mounts / env / argv the
shipped builders produce, and asserts `handlePermission` comes back over the MCP handshake. See
`docs/windows-docker-ci.md`.

## Sandbox CLI frozen at an old version — `handlePermission not found` that `docker rmi` won't fix

### Symptoms

- The SAME `MCP tool mcp__mulmoclaude__handlePermission ... not found` message as the two
  sections above. Sandbox (Docker) mode only.
- Fails on cold start and the automatic replay fails with it, so it looks like the permanent
  load failure — but the mounts and `dist` are fine.
- The tell: the CLI **inside the image** is older than the host's. Anything before 2.1.206
  crashes when `--permission-prompt-tool` is referenced before the broker connects, instead
  of waiting for it.
- Deleting the image (`yarn sandbox:remove`) and letting it rebuild leaves the version
  unchanged.

### Cause

The image freezes whichever CLI was current when it was built, and
`ensureSandboxImage()` (`server/system/docker.ts`) rebuilds only when the **Dockerfile's SHA**
changes. A new CLI release upstream doesn't change that SHA, so nothing retriggers the build.

### Fix

Read it off the boot log — since #2842 the server records the version at build time as an image
label and prints it on every start, so no container has to be run to find out:

```
INFO [sandbox] sandbox image claudeCodeVersion=2.1.220 ageDays=3
```

`claudeCodeVersion=unrecorded` means the image predates the label (or was built with npm
unreachable). In that case ask the image directly — the entrypoint override is required because
the image's ENTRYPOINT is the sandbox script, and the host's own `claude --version` says nothing
about what is inside:

```bash
docker run --rm --entrypoint claude mulmoclaude-sandbox --version
```

If it's behind, drop the image and let the next run rebuild:

```bash
yarn sandbox:remove          # docker rmi mulmoclaude-sandbox
```

Two warns fire on their own when this is worth acting on: `sandbox image is stale` past 30 days,
and `Claude CLI in the sandbox image is older than the version our MCP config needs` below
2.1.121 (the floor for `alwaysLoad`).

> **Older than #2842?** Back then the rebuild reused the cached `npm install -g` layer (reported
> `CACHED` in 0.0s) and reinstalled nothing, so `yarn sandbox:remove` alone genuinely did nothing
> and `docker builder prune -a -f` was needed. The Dockerfile now installs an exact
> `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}` resolved on the host, so a moved CLI changes
> the layer's own command string and invalidates it. Don't reach for `builder prune` first — it
> clears the cache for the whole daemon.

The CLI is deliberately left unpinned by default (#2202), so this can recur whenever an upstream
fix matters to you — the log line above is the way to rule it in or out.

## A turn dies on `handlePermission not found` — read the broker lines before anything else

### Symptoms

The same `MCP tool mcp__mulmoclaude__handlePermission ... not found` as the three sections
above, and you can't yet tell WHICH of them you are in.

### Cause

They are genuinely different failures — a permanent load failure, a startup race, a frozen CLI —
and guessing between them is what makes this expensive. Since #2842 the log answers it directly,
so read these three before forming a theory:

| Log line                                                      | What it tells you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawning agent … broker=tsx`                                 | This install is on the SLOW path: the bundle is missing, so the broker is transcoded from source on every spawn (seconds to tens of seconds over a Windows/macOS bind mount). A `broker bundle missing` warn accompanies it once per process.                                                                                                                                                                                                                                                                                                     |
| `[mcp] broker ready bootMs=… initializeMs=…`                  | The broker DID connect, and how long it took. `broker cold boot is slow` replaces it past 5 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `brokerEverReady=false reason=never-ready` on the retry warn  | No beacon arrived for that chat, and the host kept looking until the beacon's own delivery budget was spent — the broker did not come up at all. The turn is NOT replayed: a replay would sit out another full connect wait and end in the same error.                                                                                                                                                                                                                                                                                            |
| `reason=ready-during-wait` on the retry warn                  | The beacon arrived while the host waited, so the broker lost the race by a moment and IS connected now. The turn is replayed, which is what fixes this one.                                                                                                                                                                                                                                                                                                                                                                                       |
| `brokerEverStarted=` on the `MCP tools were unavailable` warn | Whether the broker PROCESS ever existed, which is a different question from whether it answered. `true` with `brokerEverReady=false` means it launched and never finished booting — the boot is the problem (the mount, the `tsx` path). `false` means it never launched — the spawn is the problem. Diagnostic only, and not authenticated: under Docker everything needed to forge it sits in the per-session MCP config inside the workspace mount, so read it as evidence about a healthy install rather than as proof against a hostile one. |

### Fix

- `broker=tsx` → this is the cold-boot cost, not the connect-wait ceiling. In a dev checkout run
  `yarn build:mcp-broker` (or plain `yarn build`); on an npm install, update `mulmoclaude` —
  published launchers have shipped the bundle since 1.9.0.
- `broker ready` present with a small `initializeMs`, failing anyway → it is the startup race,
  not the boot. See the scheduled-run section above.
- `brokerEverStarted=false` → the broker process never launched. That is the permanent load
  failure; check the `Cannot find module` section. This one surfaces fast on its own: the CLI
  notices a broker it could not spawn within seconds rather than waiting out its connect ceiling,
  so a turn that fails QUICKLY in this shape is the diagnosis, not a second symptom.
- `brokerEverStarted=true` with `brokerEverReady=false` → the process launched and the BOOT is
  what did not finish. Two sub-cases, and the elapsed time separates them: a boot still running
  when the CLI gave up eats the whole connect wait (fix the boot — the `broker=tsx` bullet above
  — rather than waiting longer), while a boot that CRASHED fails as fast as a missing binary. The
  crash reason is not in this log by construction: Claude CLI owns the broker's stderr, so read
  the `Cannot find module` section for what to check.
- Either way the turn is NOT replayed, so the cost is ONE connect wait rather than two. The first
  wait still happens — nothing can tell the broker is not coming until the CLI gives up on it —
  and the host then keeps looking for the beacon a few seconds longer before concluding it never
  will, so that a beacon merely still in flight is not mistaken for a broker that never answered.
- Do NOT read a missing `broker ready` line on its own as "the broker never started" — before
  `brokerEverStarted` existed, that inference was the only one available and it is wrong for
  exactly the case that costs the most time.
- Old or unrecorded `claudeCodeVersion` alongside any of these → rule out the frozen CLI first.

---

## Google tool — link / credential / API errors

### Symptoms

- The `google` tool (or a `google.calendar.*` remote command) fails with **"Google account not linked on this host"**.
- **"Google sign-in service unreachable"** or **"Google sign-in service returned HTTP …"**.
- **"multiple client_secret\_*.json files found"**.
- **"Google Calendar API: HTTP 403"** with a hint about enabling the API.
- **"Google Calendar API: HTTP 403 — Request had insufficient authentication scopes"** when pushing
  a collection to a calendar that is NOT in the account's own calendar list.
- **"could not obtain a Google access token"** (grant revoked).
- `calendarListCalendars` / non-primary calendar lookups fail with **HTTP 401/403 / insufficient scope**, or the list comes back empty even though the user has other calendars.

### Cause

The `google` tool runs against a Google account linked **locally on this machine** — a refresh
token stored at `~/.config/mulmo/google-token.json` (mode 600), obtained through a browser
consent (loopback + PKCE). This is independent of claude.ai Google connectors.

Two ways the link can be minted, and the tool picks automatically:

- **Default**: the user just clicks link and consents. The mulmoserver broker applies the OAuth
  client secret for the token exchange / renewal (Google requires one); it stores nothing —
  the tokens live only on this machine. **The user needs no Google Cloud setup.**
- **Own client** (advanced / self-hosters): if `~/.secrets/client_secret_*.json` exists, the
  whole flow stays on this machine and the broker is never contacted.

### Fix

- **Not linked / grant revoked** — ask the user to link (or re-link) the account from this app's
  settings, then retry. Do NOT tell them to create a Google Cloud project, and do NOT try to
  create or edit the token file yourself.
- **Calendar-list / non-primary lookup fails with insufficient scope (or lists nothing)** — the
  account was linked before the calendar-list read scope (`calendar.calendarlist.readonly`) was
  added, so the stored grant predates it. Ask the user to re-link from settings to add the scope,
  then retry. Reading events on a non-primary calendar by id needs no re-link once the calendar
  list is visible.
- **Sign-in service unreachable / HTTP error** — the broker is down or the network is blocked.
  It is only needed to link and to renew an expired access token; ask the user to retry shortly.
  (A user with their own `~/.secrets/client_secret_*.json` never depends on it.)
- **Multiple client secrets** — the user has several `client_secret_*.json` in `~/.secrets/`;
  a stored refresh token pairs with exactly one OAuth client, so the choice is refused rather
  than guessed at. Ask them to keep one — or remove all of them to use the default flow.
- **403 "insufficient authentication scopes" pushing to a calendar not in the user's list** —
  read the 403's BODY before the bullet below, which does not apply here: this one is about the
  grant, not the Cloud project, so enabling an API changes nothing. On hosts predating the #2735
  fix (`@mulmoclaude/core` 1.13.0 and earlier) the push asked `calendars.get` for that calendar's
  timezone, and NONE of the four scopes this app requests grants that call, so it failed for every
  account ever linked. **Re-linking does not help either** — consent grants the same four scopes.
  Either update the host, or have the user **add the shared calendar to their own Google Calendar
  list** (Other calendars → Subscribe), after which the push reads its timezone and role from the
  list and never takes that path. A calendar the user has already added was never affected.
- **HTTP 403 naming a Google API** — the API is not enabled for the Cloud project behind the
  client in use. With their own client, ask them to enable that API in the Cloud Console
  (APIs & Services → Library — the error names it: "Google Calendar API", "Google Tasks API",
  or "Google Drive API"), then retry — no re-link needed. On the default (broker) flow this
  should not happen; report it rather than sending the user to the Console.
- **Drive shows nothing / "I can't find the user's file"** — not an error. The app holds the
  `drive.file` scope, so it can only ever see files IT created; the user's wider Drive is
  invisible by design. Say so plainly instead of implying an empty Drive.

## Custom view — some images 429 / only a few thumbnails render

### Symptoms

- A collection's custom view renders records fine, but only a handful of its
  `image`-type field thumbnails appear; the rest stay placeholders.
- The view's error UI (or console) shows **HTTP 429** from
  `<dataUrl>/image` with **"too many concurrent queries for this collection —
  retry shortly"**.

### Cause

The view resolves every image at once — typically a `Promise.all` over all
records firing one `GET <dataUrl>/image` each. The host caps in-flight
`/image` + `/query` requests at **4 per collection** (each request re-scans
the records for authorization), and answers the overflow 429. The paths are
valid; only the burst is.

### Fix

Edit the view's image-resolution code (`views/*.html` under the collection's
skill directory) to throttle: a small worker pool (≤ 3 concurrent) draining a
queue of paths, with one short-delay retry on 429. See the throttled-resolver
example in `custom-view.md` ("Displaying images"). Do NOT widen the server
cap, switch to base64-embedding images in the HTML, or treat the 429'd paths
as bad values.

## An API key in `.env` has no effect — the shell is shadowing it

### Symptoms

- The user says they put a key (`GEMINI_API_KEY`, `OPENAI_API_KEY`, …) in
  `.env` and restarted, but generation still fails with an auth / 401 /
  "API key not valid" error from the provider.
- They may have edited `.env` several times, each time with no change.
- The bell may show **"Shell env is overriding .env"**, and the server log
  a `[shadowed-env]` warning naming the keys.

### Cause

An exported shell variable beats the file. `.env` is loaded with
no-override semantics, so if `~/.zshrc` (or the current shell) still holds
`export GEMINI_API_KEY=<old value>`, the file's value is read and
discarded. Editing `.env` cannot fix it, which is why the loop repeats.

An **empty** export shadows just as hard: `export GEMINI_API_KEY=` counts
as set, so the provider receives an empty key while a perfectly good one
sits in `.env`.

Two files can be shadowed this way — the directory the user launched from
(`npx mulmoclaude`) and the server's own working directory (`yarn dev`).

### Fix

Have the user check the shell, not the file. Test whether the variable
is **set**, not whether it prints something — `export GEMINI_API_KEY=`
prints nothing and still shadows, which is the case `echo` cannot see:

```bash
[ -n "${GEMINI_API_KEY+x}" ] && echo "set in the shell — this is what the app uses" \
                             || echo "not set — the shell is not the problem"
```

If it reports "set", that shell value is what the app is using, whatever
`.env` says. Either correct the export, or remove it — from the current
shell AND from `~/.zshrc` / `~/.bashrc`, or the next terminal brings it
straight back — so the `.env` value takes effect. Restart the app
afterwards; the load happens once at boot.

Do NOT tell the user to re-check the spelling in `.env`, add the key
again, or move it elsewhere; the file is already correct, and it is being
read. The conflict is the whole problem.

## A `putItems` batch is too large to pass inline — use `itemsFile`, never the MCP bridge

### Symptoms

- You generated records with a script (a month of booking slots, an imported
  CSV, anything past a few dozen rows) and the only way you can see to store
  them is to write every object into `manageCollection`'s `items` argument.
- You start looking for the collection's data directory on disk, or for a way
  to hand the file to the tool.
- The next step that suggests itself is spawning `server/mcp/bridge.mjs` (or
  the host's MCP server) yourself and speaking JSON-RPC to it from a script.

### Cause

`items` takes the rows inline, so a 540-row batch means writing ~80 KB of JSON
token by token — even when a script already produced exactly that JSON as a
file. The judgement that the batch cannot go through `items` is correct; only
the workaround is wrong.

### Fix

Pass the file instead. `putItems` accepts **`itemsFile`** — an absolute path to
a JSON file holding the array of record objects, read by the host:

```jsonc
{ "action": "putItems", "slug": "slots", "mode": "create", "itemsFile": "/absolute/path/to/generated-slots.json" }
```

Write the generated file **under the workspace**. Paths outside it are refused:
the host reads this file on your behalf, so an unconstrained path would let the
tool reach host files you cannot otherwise see. Under a sandbox your workspace
path is translated to the host's automatically — you pass the path you wrote to.

Rules that make it fail cleanly rather than silently:

- **Absolute paths only.** The tool runs in the host's SERVER process, whose
  working directory is not yours; a relative path is refused rather than
  resolved against some unrelated directory.
- **Inside the workspace only**, and **not a symlink** — pass the real path of a
  regular file. Symlinks are refused rather than followed, contained or not.
- **`items` or `itemsFile`, never both** — passing both is refused, not merged.
- **1000 rows per call, max**, and the file itself at most 8 MiB. Over either,
  the call is refused WHOLE with nothing written; split the file and call again,
  so you never meet a half-filled collection.

Reading the refusal you got:

| Message                                              | What it means                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `must be an ABSOLUTE path`                           | You passed a relative path. Pass the full one.                                                                                                                                                          |
| `must be inside the workspace`                       | The file is outside the workspace (or a symlink out of it). Regenerate it under the workspace.                                                                                                          |
| `is a symbolic link`                                 | Symlinks are never followed. Pass the real path.                                                                                                                                                        |
| `changed while it was being opened`                  | The file was replaced mid-call. Finish writing it, then call putItems.                                                                                                                                  |
| `grew while it was being read`                       | The file was still being written. Wait for the script to finish, then call putItems.                                                                                                                    |
| `could not read \`itemsFile\``                       | The host cannot see that path — the usual cause is a file written to a temp dir outside the mount. Write it under the workspace.                                                                        |
| `is not a regular file`                              | The path is a directory, device, or fifo.                                                                                                                                                               |
| `could not be read as JSON`                          | The file exists and was read, but does not parse. This is YOUR file's shape, not a host problem — check the script that wrote it (a truncated write, a trailing comma, log output mixed into the file). |
| `must hold a non-empty JSON array of record objects` | It parsed, but is `[]`, an object, or an array of scalars. The file must be `[{…}, {…}]` — the same row objects you would have passed as `items`.                                                       |

Do NOT spawn the MCP bridge yourself. A hand-written JSON-RPC client fails
invisibly and can leave a partially written collection that nothing reports.

## `putItems` came back with a `lint` block — the rows were written, the values are the wrong shape

### Symptoms

- A `putItems` result carries `lint` beside `written`: `{ total, note, rows: [{ id, problem }] }`.
- The problem text reads like a type complaint rather than a missing field —
  `not a YYYY-MM-DDTHH:MM datetime`, `is not numeric`, `is not a real YYYY-MM-DD date`,
  `is not a boolean`.
- `rejected` is empty, and the records are on disk, so nothing looks broken yet.

### Cause

The write gate refuses only what makes a record unopenable: required fields,
enum values, `primaryKey` = record id. The SHAPE of a value is checked by a
second, report-only tier — refusing there would make a collection whose older
rows predate the typed rules unwritable. So the row lands, and `lint` is the
report.

It is not cosmetic. Every later reader runs the strict tier: a full `getItems`
listing (and a selective one that missed an id) returns the same finding as a
`warning` beside the rows, and publishing a shared app REFUSES these rows
outright. A batch generated by a script is wrong in every row the same way, so
this is the moment it costs the least to fix.

### Fix

Correct the generator, then rewrite the rows (`mode: "upsert"`, same ids) and
check that `lint` is gone. `lint.total` is the real count; `lint.rows` shows the
first ten.

The one that recurs is `datetime`. It stores a **local wall clock** —
`YYYY-MM-DDTHH:MM`, seconds optional, **no `Z` and no offset** — because `08:00`
in a schedule means eight in the morning wherever it is read, and that is what
the calendar can place. So format the string, never convert it:

```js
// WRONG — appends `Z` and shifts the hours by the generating machine's offset
{
  startAt: new Date(`${day}T08:00`).toISOString();
} // "2026-08-17T15:00:00.000Z"

// RIGHT — the clock you meant, written as the clock
{
  startAt: `${day}T08:00`;
} // "2026-08-17T08:00"
```

The conversion is the more expensive half: had the format passed, a Tokyo court's
08:00 seeded on a US laptop would have published every slot seven hours out
(eight, on the dates the other side of a DST change) with nothing to point at.
The one `Z`-suffixed datetime the strict tier accepts is a shared app's
server-stamped instant — nine fractional digits
(`2026-08-15T01:45:54.605987654Z`), written by the server, not by you.
`toISOString()`'s three digits are not that shape and are linted.

Field-by-field stored forms: `schemaDocs` with `topic: "Field types"`.

## A tool your own instructions describe returns "No such tool available"

### Symptoms

- The Plugin Instructions section of your system prompt documents a tool
  (`mcp__mulmoclaude__google`, `mcp__mulmoclaude__manageSpotify`, any
  plugin-backed name), but calling it errors with `No such tool available`.
- `ToolSearch select:<that name>` reports no matching deferred tool either.
- Static tools in the same session (`presentDocument`, `presentForm`, …) work.

### Cause

The tool surface is published by a separate MCP broker process, and plugin-backed
tools register there a moment after the session's tool list is first taken. A
session that captured the list too early keeps one that lacks exactly those
tools — while the system prompt, built in the server where the plugin IS
registered, still describes them.

### Fix

Tell the user plainly that the tool is unavailable in THIS session and that
starting a new chat re-takes the tool list. Do NOT invent a fallback: reading
the account's stored credentials, shelling out to a provider CLI, or
reconstructing the call by hand is worse than the missing tool, and it is not
what the user asked for.

If a new chat has the same gap, the broker did not publish the tool at all.
Ask the user for the server log around the session start — the broker prints
`[mcp-server] publishing N tools: …` and, when a promised tool is missing,
`[mcp-server] advertised but NOT published (check plugin load above): …`. That
second line, with the plugin-load errors above it, is what a bug report needs.

## A shared collection (`storage: firestore`) is empty, refused, or missing

### Symptoms

- Reading or writing a collection fails with `shared collection unavailable:
connect remote-host first`.
- A collection whose `schema.json` declares `"storage": { "type": "firestore" }`
  never appears in the list at all.
- Reads and writes fail with `permission-denied` from Firestore even though the
  session is connected.

### Cause + fix

These are three different states, and the fix differs. Do NOT treat any of them
as "the collection has no records" — a shared collection's records live in its
app's Firestore, so an empty screen would be indistinguishable from data loss.
The backend deliberately fails loudly instead of returning nothing.

1. **`connect remote-host first`** — there is no authenticated session, or the
   signed-in user has no email address. The records are not on this machine and
   nothing can be read or written until the user connects remote-host. Tell them
   that; do not retry in a loop and do not fall back to a local file.

2. **The collection never appears** — discovery REFUSED the schema, and the
   reason is in the server log under `collections` (`schema.json rejected after
validation, skipping`). For a shared collection the usual reason is the app
   declaration: `apps/{aid}/collections/{cid}/items` needs an `aid`, which comes
   from `app.json` at the repository root, not from the schema.

   `<repository root>/app.json`:

   ```json
   { "aid": "app_salon_7f3a" }
   ```

   `aid` must be alphanumeric with `-` / `_` inside it (the same charset as a
   collection slug); `sales:2026` or a path is refused, because that name is
   re-encoded downstream as a document id and a channel name. Never put `aid`,
   `cid` or `path` in the schema's `storage` block — it takes none of them, and
   writing one is a validation error rather than a silently-dropped key.

3. **`permission-denied` while connected** — the app's member roster is what
   authorizes a shared collection, and it is keyed by EMAIL. The signed-in
   address must be listed in `apps/{aid}.members` with a role for that
   collection (or `*`). This is not something the host can fix locally: the
   app's owner has to add the address. Report which address is signed in — that
   is the fact the owner needs.

Deleting a shared collection is refused outright: the delete can neither archive
nor remove documents that other members also read, and removing its records
first does not unlock it. Retiring the whole app is a Firestore project
administrator's recursive delete, not something this app does.

## A messaging bridge's bot does not reply, and nothing errors

### Symptoms

The user talks to the bot on Telegram / Slack / LINE / Discord / …, and nothing
comes back. No error in the server log, none from the bridge. Sending again does
nothing either.

### First, do NOT say "restart the bridge"

That advice is out of date. Since #3078 the shared client re-reads the token and
the port after **every failed connection** and rebuilds its socket when the
server has come back as a different generation. A server restart — new token,
new port, or both — is handled without touching the bridge.

### The bridge tells you where it went — start there

Every bridge prints its target as it starts — the shared client emits it, so
this holds for all of them, not only the ones with a banner:

```text
Connecting to http://127.0.0.1:3099
```

It prints again each time the bridge follows the server to a new address, so a
bridge that has outlived a restart has several. **Compare the last one** — the
earlier lines are where it used to be. Against what the server published:

```bash
cat "${MULMOCLAUDE_WORKSPACE_PATH:-$HOME/mulmoclaude}/.server-port"
```

- **They agree** → the address is right; the problem is further in (see below).
- **They disagree**, and the bridge says `http://localhost:3001` → that bridge
  is an npm build from before the port-following fix. Reinstall it
  (`npm i -g @mulmobridge/<platform>@latest`, or `npx @mulmobridge/<platform>@latest`).
  Check the banner rather than a version number: the banner is the behaviour,
  and a version is one more thing to keep current.

### `The server has not published a port yet` is waiting, not failing

```text
The server has not published a port yet — waiting for it rather than guessing.
```

The server writes `.session-token` before it binds its port, and sandbox setup
sits in between — a cold start that builds the Docker image can hold there for
minutes. The bridge deliberately refuses to guess `localhost:3001` while holding
a freshly minted token, and joins on its own once the port appears. Wait, or
check that the server is actually starting.

### A bridge that cannot see the workspace needs both variables

Running on another machine, or in a container without the workspace mounted,
means no `.server-port` and no `.session-token`. Such a bridge needs BOTH:

```bash
MULMOCLAUDE_API_URL=http://127.0.0.1:<port> \
MULMOCLAUDE_AUTH_TOKEN=<the same value the server was given> \
  npx @mulmobridge/<platform>
```

Two things make this narrower than it looks:

- **The server binds the IPv4 loopback only** (`app.listen(port, "127.0.0.1")`),
  so a bridge on another machine cannot reach it by naming the host. It needs a
  tunnel — an SSH port-forward is the usual one — and then
  `MULMOCLAUDE_API_URL` points at the LOCAL end of that tunnel, which is why the
  recipe above still says `127.0.0.1`. Do not "fix" this by making the server
  listen on `0.0.0.0`: there is no TLS on that port, and the bearer token would
  cross the network in the clear.
- **`MULMOCLAUDE_AUTH_TOKEN` must be set on the SERVER too**, or it regenerates a
  new token on every start and the pinned one stops matching.

In a container on the same host, `MULMOCLAUDE_HOST=host.docker.internal` is how
the sandbox's own hooks reach the parent server; a bridge there needs the same
treatment, and the workspace mounted if you want it to follow the port.

### Only then, the platform side

- The chat ID is not on the bridge's allowlist — the bot answers
  `"Access denied"` to a stranger, but an allowlist typo simply drops the
  message.
- The platform token (bot token, app token) was revoked or regenerated.
- The bridge process is not running at all. Check before assuming anything above.

### What to collect if none of it explains the silence

The bridge's first three lines (they name the transport and the resolved URL),
the server's `[server] listening port=…` line, and whether
`<workspace>/.server-port` exists. Those three answer "which server, on which
port, and did the bridge agree" — which is what every one of these turns out to
be.

## A webhook bridge exits at startup, or never binds its port

### Symptoms

One of the webhook bridges — `line`, `line-works`, `google-chat`, `messenger`,
`teams`, `twilio-sms`, `viber`, `webhook`, `whatsapp` — exits immediately after
being started, printing one of:

```text
Port 3002 is already in use. Set LINE_BRIDGE_PORT to a free port, or LINE_BRIDGE_PORT=0 to let the OS pick one.
LINE_BRIDGE_PORT="302a" is not a usable port. Set it to an integer from 0 to 65535 (LINE_BRIDGE_PORT=0 asks the OS for a free port), or unset it to use 3002.
```

Both name the env var to change, and each bridge has its own — `WEBHOOK_PORT`,
`TWILIO_WEBHOOK_PORT`, `VIBER_WEBHOOK_PORT` and so on. Read the message rather
than guessing the name.

### "Already in use" is usually the server, not a second bridge

The server's port walk (3002-3021) covers the whole bridge band (3002-3013), so
a server that found 3001 busy and moved forward can be sitting on a bridge's
default. Check what the server actually bound before moving the bridge:

```bash
cat "${MULMOCLAUDE_WORKSPACE_PATH:-$HOME/mulmoclaude}/.server-port"
lsof -nP -iTCP:3002 -sTCP:LISTEN
```

Two ways out, both fine:

- Give the bridge a port outside the server's band: `LINE_BRIDGE_PORT=3200`.
- Let the OS choose: `LINE_BRIDGE_PORT=0`. The startup banner then names the
  port it actually got — read the banner, not the env var, when tunnelling to it
  (`Webhook listening on http://localhost:52431/webhook`).

### Before #3084 both of these were silent

A bridge of that vintage reads its port as `Number(process.env.X) || <default>`
and calls a bare `app.listen`. So a **typo ran on the default without a word**
(`302a` → `NaN` → falsy → the default), `X=0` was impossible (falsy too), and a
busy port surfaced as an unhandled `EADDRINUSE` with no mention of which env var
to change. If neither message above appears and the bridge simply dies, or it is
answering on a port you did not ask for, that is the old build: reinstall it
(`npm i -g @mulmobridge/<platform>@latest`).

A bridge that starts but never replies is a different failure — see "A messaging
bridge's bot does not reply, and nothing errors" above.

## `renderShapeScript` says Chromium is not installed

`renderShapeScript` rasterises a ShapeScript model by driving Puppeteer's
headless Chromium — the same browser the PDF export uses. Puppeteer downloads
it at install time, so this normally just works; a host that set
`PUPPETEER_SKIP_DOWNLOAD`, or a sandbox that cannot spawn a browser, has none.
The tool then returns, instead of an image path:

```
renderShapeScript needs Puppeteer's headless Chromium, which this host does
not have. Run `npx puppeteer browsers install chrome`, then retry.
```

What to do:

1. Tell the user the one command above.
2. Do NOT retry the call — nothing about the model changed, so the
   second attempt fails identically.
3. Carry on with `presentShapeScript`, which needs no browser: it
   validates the geometry headlessly and shows the model to the user
   in the chat canvas. The only thing you lose is your own ability to
   LOOK at the render before presenting it, so be more conservative
   about complex geometry and describe what you built rather than
   claiming you verified its appearance.

The same message with `(launch failed: …)` appended means the browser is
installed but would not start — usually a sandbox with no permission to
spawn it. Report the parenthesised reason to the user rather than the
install hint alone.
