# Remote Host — driving MulmoClaude from your phone

**Remote host** lets a phone browser invoke capabilities on your own MulmoClaude
server — list collections, render mobile custom views, edit records, start a
chat with image attachments — **without** exposing the server to the internet,
running Cloud Functions, or polling. The transport is a **Firestore-backed
request/response channel** in a shared public Firebase project; the phone writes
a command document, the server claims it, runs a handler, and writes the result
back over a real-time listener.

The mobile client itself (`https://mulmoserver.web.app`) lives in the sibling
repo `../mulmoserver` and is **not** part of this repo. This repo ships the
**host** half — the Firestore command loop, the handler table, and the toolbar
Connect/Disconnect control — plus the shared contract that both sides compile
against (`@mulmoclaude/core/remote-view`).

---

## The big picture

```text
  Phone browser                     Firestore (project "mulmoserver")                MulmoClaude server (Node)
  mulmoserver.web.app               the relay — no P2P, no Cloud Functions           this repo, host-only
  ───────────────────               ─────────────────────────────────               ─────────────────────────
   Google sign-in
        │  writes command doc
        │  users/{uid}/hosts/mulmoclaude/commands/{id}
        │  { method, params, status:"queued", createdBy:"remote" }
        ▼
                                    ┌──────────────────────────────┐
                                    │  users/{uid}/hosts/           │  onSnapshot(where status=="queued")
                                    │    mulmoclaude/commands/{id}  │◄──────── host claims via runTransaction
                                    │  status: queued→processing    │           (queued→processing, exactly once)
                                    │         →done | error         │           runs handlers[method](params)
                                    │  result / error written back  │────────► writes status:"done" + result
                                    └──────────────────────────────┘
        │  real-time listener on the same doc
        ▼
   renders result
                                    ┌──────────────────────────────┐
                                    │  users/{uid}/hosts/mulmoclaude │  presence doc — host heartbeats
                                    │  { online, updatedAt,          │◄──────── every 60s while connected
                                    │    hostId, protocolVersion,    │           online:false on stop/death
                                    │    capabilities:[method,…] }   │
                                    └──────────────────────────────┘
        │  reads presence → "host online?" + which methods it serves
```

Both sides agree on a hardcoded **`hostId = "mulmoclaude"`** — there is no host
discovery or registry. Isolation is by subcollection: a user running several
hosts under the same account (laptop + this MulmoClaude) never compete for each
other's commands.

---

## Auth model — "Option B: the server signs in as the user"

The server authenticates to Firestore **as the user**, using the Firebase JS SDK
(no Admin SDK, no project service account distributed to self-hosted installs):

1. In the browser, `RemoteHostControl.vue` does `signInWithPopup(GoogleAuthProvider)`
   and extracts the short-lived **Google OAuth ID token**
   (`GoogleAuthProvider.credentialFromResult(result).idToken`).
2. It POSTs that token to the **loopback** route `POST /api/remote-host/connect`.
3. The server calls `signInWithCredential(auth, GoogleAuthProvider.credential(idToken))`
   → gets `auth.currentUser.uid`, then starts the host runner. The JS SDK holds
   its own refresh token for the process lifetime; the ID token is used once.

Security rules keep the server scoped to the user's own subtree:

```
match /users/{uid}/{document=**} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
}
```

The server holds **no project-wide privilege** — blast radius is the user's own
`users/{uid}/…` Firestore subtree. The ID token is treated as a secret: POSTed
over localhost only, never logged, not persisted to disk. The session is
**in-memory** — a server restart drops it and needs a re-connect.

> **Firestore must be in Native mode** — Datastore mode silently no-ops the web SDK.

---

## Where the code lives — shared transport in core, host specifics local

The generic transport is **extracted into `@mulmoclaude/core`** so both hosts
(MulmoClaude, MulmoTerminal) share one copy instead of each porting it from
`../mulmoserver` (which is where it originated). Two subpaths, split on the
browser-safe boundary — mirroring `@mulmoclaude/core/remote-view`:

| Import | Surface | Provides |
|---|---|---|
| `@mulmoclaude/core/remote-host` | **browser-safe** | Protocol wire types (`Command`, `CommandStatus`, `Channel`, `CommandHandlers`) + the capability advertisement (`HostPresence`, `REMOTE_HOST_PROTOCOL_VERSION`, `buildHostPresence`) + channel health (`RunnerHealth`, `RUNNER_HEALTH_STATES`, `isRunnerHealth`) for a host that renders it. Shared by host **and** the mobile client. Loads without `firebase`. |
| `@mulmoclaude/core/remote-host/server` | **server-only** | `startHostRunner(firestore, channel, handlers, opts)` — the command loop; `startResilientHostRunner(deps)` — the outer recovery ring around it; `createPresenceProbe(deps)` — the liveness sensor it reads; `createRemoteHost(deps)` — the connect/disconnect/status lifecycle factory; `createRemoteHostAuth(auth)` + `createRemoteHostFirebase(config)` — the Firebase init/auth primitives; `commandsCollection(firestore, channel)` / `hostDoc(firestore, channel)` — the Firestore path helpers. `firebase` is an optional peer dep of core. |

Each host supplies only its own specifics under `server/remoteHost/`:

| File | Responsibility |
|---|---|
| `index.ts` | Binds this host's `hostId="mulmoclaude"`, handler table, firestore-bound runner, and logger to core's `createRemoteHost`; exposes the default singleton the route uses. |
| `session.ts` | This host's Firebase handles + the signed-in session: `createRemoteHostFirebase(firebaseConfig)` → `{ firestore, auth, storage }` (Firestore must be in Native mode), `createRemoteHostAuth(auth)` → `signIn` / `signOut` / `currentUid`, plus `currentFirestore()` / `exportSession()`. |
| `commandChannel.ts` | Re-exports the core protocol + pins `HOST_ID = "mulmoclaude"`. |
| `handlers/index.ts` | The method table — the single place the runner learns which methods it serves. |

### The command loop, precisely (core `startHostRunner`)

- **Presence + capabilities.** `writePresence(true)` on start, then a heartbeat
  `setInterval` once a minute (`opts.heartbeatMs`, default 60 s). Every write
  carries the capability advertisement (next section), not just the `online` flag.
- **Listener resilience (#2535, #2633).** A Firestore `onSnapshot` error no longer
  downs the host permanently. `classifyListenerError` splits transient codes
  (`unavailable`, `deadline-exceeded`, `internal`, `cancelled`, `aborted`,
  `resource-exhausted`, `unauthenticated`) from fatal ones (`permission-denied`,
  or any unrecognized code). Transient → re-subscribe with exponential backoff
  (1 s, 2 s, 4 s, … capped at 30 s by `backoffDelayMs`) while presence stays
  online, so a brief blip doesn't flap the host. Retrying stops when the outage
  has lasted `LISTEN_RETRY_WINDOW_MS` (5 min) **measured from the first failure**
  — a retry COUNT put that at ~31 s, which any laptop sleep outlasts (#2633).
  Fatal, or window elapsed → announce offline, clear the interval, detach the
  listener, `onClosed()`. A healthy snapshot clears both the ladder and the
  outage clock; `stop()` cancels any pending retry. Re-subscribe is safe against
  double execution — `claimCommand`'s queued→processing transaction still gates
  each command exactly once.

### Staying reachable — two rings, and why one wasn't enough (#2633)

The phone judges "is the Mac reachable" from the **freshness of the presence
doc**. The host used to judge "am I connected" from **listener errors only**.
Those are separate paths, so presence writes could fail forever while
`onSnapshot` stayed quiet: the host reported itself green, retried nothing, and
an open browser tab didn't help because the tab only reconnects once the server
admits it is disconnected.

- **Inner ring — core (`presenceBeat.ts`).** Each heartbeat first asks how old the
  last *acknowledged* presence write is. Older than `PRESENCE_STALE_BEATS` (3)
  beats ⇒ the remote has nothing fresh to read, so the runner reports it through
  `onEvent` and goes offline instead of claiming to be up. The sensor is
  acknowledgement AGE, not a count of failures: Firestore does not reject a write
  it cannot deliver, it queues it and leaves the promise pending, so a failure
  counter reads zero throughout an outage.
- **Outer ring — core (`resilientRunner.ts`, `startResilientHostRunner`).** When
  the inner ring gives up, this starts a whole new runner (fresh listener, fresh
  presence write) with its own backoff, and gives up by TIME (`GIVE_UP_MS`,
  5 min). Only then does `onClosed` reach the lifecycle → `status()` reports
  disconnected → the client's 15-second poll re-authenticates from its parked
  blob, which is the only path that fixes a dead credential. It also runs
  `presenceProbe` every 90 s: a **server** read of this host's own presence doc
  (never the cache, which would happily return our own undelivered write). A stale
  doc, or a read that throws, enters the same recovery a listener death does.
  `null` — no document, an unresolved `serverTimestamp`, or the runner's own
  `online: false` goodbye — is deliberately not actionable: a false positive spins
  a reconnect loop. The read carries its own deadline (`withTimeout`): Firestore
  takes no abort signal, and a read that never settles would leave the probe
  un-rearmed — a sensor dying quietly, which is the failure this whole section
  exists to catch.
- Surviving the settle window (60 s) counts as recovery **only** if the probe
  agrees. The inner ring takes minutes to report a broken channel, so "it hasn't
  complained yet" proves nothing — and if that reset the outage clock, a host with
  a dead credential would relaunch forever and never escalate.
- **Both rings live in core (#2643).** They used to be one ring each: the inner in
  core, the outer copied into MulmoClaude and MulmoTerminal. That split is unsound,
  because the outer ring's correctness is a RELATION between constants — `SETTLE_MS`
  must outlast how long the inner ring takes to report, and `PROBE_INTERVAL_MS`
  must sit above `presenceStaleAfterMs()`. Raising `LISTEN_RETRY_WINDOW_MS` from
  ~31 s to 5 min disabled `giveUp` outright in the copy that had not been told: the
  60 s settle always fired first, reset the outage clock, and the host relaunched
  forever while reporting itself online — so the client was never asked to
  re-authenticate. Changing one ring's timing now shows up next to the rule that
  depends on it.
- **Health reporting is optional.** `onHealth` gets `{ state, lastError, changedAt }`
  on each transition (`online` / `reconnecting` / `offline`) for a host with a
  toolbar control; MulmoClaude passes none. An ongoing outage reports **once** — a
  fresh `changedAt` per relaunch would reset a "down for N seconds" readout every
  backoff step. The state names and their guard are browser-safe so the control
  narrows what the server writes; the wording stays in each host's i18n.

### Capability advertisement — presence doc, auto-derived

The remote has no host registry and no way to know *which* methods a given host
build serves — a self-hosted install may be older, or ship a plugin that adds or
drops a capability. Rather than let the remote discover this by firing a command
and getting `unknown_method` back, the host **advertises its capabilities in the
presence doc** the remote already listens to:

```jsonc
// users/{uid}/hosts/mulmoclaude
{ "online": true, "hostId": "mulmoclaude", "protocolVersion": 2,
  "capabilities": ["listCollections", "getCollection", "startChat", …],
  "updatedAt": <serverTimestamp> }
```

- **Push, not pull.** It rides the same `onSnapshot` the remote runs for
  online/offline, so the remote knows the capability set the instant the host is
  online — no extra round trip, and it can gate UI (hide "send photo" when
  `startChat` is absent) *before* issuing anything.
- **Auto-derived, single source of truth.** `buildHostPresence` sets
  `capabilities = Object.keys(handlers)` from the live handler table, so
  registering a handler in `handlers/index.ts` is the **only** step needed to
  advertise it — there is no second list to keep in sync (the same
  "derive, don't duplicate" discipline as the handler table itself).
- **`protocolVersion`** (`REMOTE_HOST_PROTOCOL_VERSION`, currently `2`) lets the
  remote gate on wire-protocol compatibility independent of the method list; bump
  it when the command channel changes shape in a way the remote must react to.
  **v2** signals offline-queue support (the host honours `expiresAt` — deletes an
  expired command + its staged uploads instead of spawning a stale chat); a remote
  MUST see `protocolVersion >= 2` before queueing a `startChat` while offline (see
  "Offline queueing").
- The payload shape (`HostPresence`) is a **browser-safe** export both repos
  compile against, so host and mobile client can't drift on the contract.
- **`undefined` never costs the whole reply (#2634).** Firestore rejects
  `undefined` at ANY depth, so one stray value buried in a handler's return made
  `updateDoc` throw — `status:"done"` never landed and the remote waited out its
  timeout. The symptom was "nothing arrives", not "one field is missing". Before
  writing, the runner strips every `undefined` (object keys dropped, array holes
  → `null` so indexes still line up) and reports the paths it dropped through
  `onEvent`: `result.sessions.11.work`, which Firestore's own error never tells
  you. Stripping rather than throwing is the point — a throw reproduces exactly
  the outcome this prevents. Paths where `undefined` is legitimate are declared
  per method via `opts.expectedUndefined` (`{ listSessions: ["sessions.*.work"] }`,
  `*` = one segment): still stripped, silently, so the report stays worth reading.
  Deliberately NOT `ignoreUndefinedProperties` — that turns the bug into "the
  value just doesn't arrive", with nothing to grep for.
- **Claim exactly once.** `claimCommand` runs a `runTransaction` that reads the
  doc and only flips `queued → processing` if it is still `queued`; a second
  host (or a snapshot replay) that races gets `null` and skips it.
- **Run + write back.** `runHandler` calls `handlers[method](params)` and writes
  `status:"done"` + `result`, or `status:"error"` + a `{code,message}`. Unknown
  methods write an `unknown_method` error. Write-after-delete is swallowed
  (the remote may have deleted the doc on its own timeout).

### Handler table (capabilities)

Each handler runs **in-process**, bypassing the HTTP bearer/view-token layer and
calling the collection engine directly. Added incrementally across phases:

| Method | What it returns | Phase |
|---|---|---|
| `listCollections` | Collections (feeds excluded), same shape as `GET /api/collections` | 1 |
| `getCollection` | One collection's detail + a page of records | 2 |
| `listShortcuts` | Pinned launcher favorites (read-only) | — |
| `listSkills` | Skill ids as `string[]` | — |
| `listFeeds` / `getFeed` | Feed registry / one feed's detail page (read-only) | — |
| `listAccountingBooks` | `{ books: [{id,name}] }` for a mobile book picker | — |
| `getRemoteView` | A `target:"mobile"` custom view built into a sandboxed `srcdoc` | 3 |
| `getRemoteViewItems` | One page of a view's records, image fields inlined as `data:` thumbnails | 5 |
| `mutateRemoteViewItem` | Applies an update/delete from a mobile view; policy enforced **host-side** | 4 |
| `startChat` | Starts a visible chat from the phone (message + optional role + attachments) | — |
| `ingestAttachments` | Pulls staged files from Firebase Storage into the workspace | — |
| `google.calendar.createEvent` | Creates a Google Calendar event (`{ event }`); params `summary`, `start`, `end` (ISO 8601), optional `description`, `calendarId`, `colorId` | — |
| `google.calendar.updateEvent` | Edits an event in place (`{ event }`); requires `eventId` plus at least one of `summary`, `start`, `end`, `description`, `colorId`; optional `calendarId`. `description: ""` clears it, omitting it leaves it | — |
| `google.calendar.deleteEvent` | Removes an event (`{ deleted, eventId }`); requires `eventId`, optional `calendarId` | — |
| `google.calendar.listEvents` | Upcoming events (`{ events }`, each with `colorId`); optional `calendarId` (default primary), `timeMin`, `maxResults` (≤ 50) | — |
| `google.calendar.listCalendars` | Calendars the user has added/subscribed to (`{ calendars }` — id, summary, primary, colours) | — |
| `google.calendar.colors` | Event/calendar colour palettes mapping `colorId` → hex (`{ colors }`) | — |

The `google.calendar.*` handlers run against the **host's own Google OAuth
grant** (independent of Firebase Auth): the user links the account once — from
the settings modal (Plugins → Google) or with `yarn google:auth` (both run the
same loopback + PKCE consent in the browser; the settings flow requires the
browser to be on the same machine as the host) — and the refresh token stays
in `~/.config/mulmo/google-token.json` (mode 600).

Google requires a client secret at its token endpoint even under PKCE, so a
user with no Cloud project of their own cannot finish a link unaided. Two
paths, chosen automatically:

- **Default** — the **mulmoserver broker** (`/googleOAuthStart`, `/googleOAuthCallback`,
  `/googleOAuthExchange`, `/googleOAuthRefresh`; receptron/mulmoserver#54) applies the secret.
  It is **stateless**: it stores no token and no code, and the callback 302s the *authorization
  code* — never a token — back to this host's loopback, which then exchanges it itself. The
  tokens never leave the machine, so there is no central honeypot. The broker is contacted only
  when linking and when an expired access token needs renewing.
- **Own client** — if `~/.secrets/client_secret_*.json` is present it wins, and the whole flow
  (consent, exchange, refresh) stays on this machine. Self-hosters keep full independence.

The stored token records which path minted it (`issuedVia`), so renewals take
the matching one; tokens written before the broker existed are treated as
`local`. Until the account is linked, the handlers
return a `handler_error` telling the remote to run the auth flow on the host.
The remote can tell whether a host build supports Calendar by looking for the
`google.calendar.*` method names in the presence `capabilities` (auto-derived,
like every other method).

---

## Custom mobile views — the postMessage bridge (phase 3+)

A phone can't reach the host's `localhost`, and handing the sandboxed iframe
Firestore credentials would defeat the sandbox. So mobile custom views replace
the desktop pattern (fetch `/view-data` with a scoped token) with an **async
postMessage bridge**: the parent page owns the data channel, and the injected
bootstrap exposes a small API the LLM-authored view just awaits.

- The whole contract is a **browser-safe** subpath: `@mulmoclaude/core/remote-view`
  — CSP builder, srcdoc wrapping + bootstrap injection, pagination clamps + field
  projection, and the parent-side message handler. It is the **single source of
  truth** for both the desktop preview and the mulmoserver client, so parity is
  structural rather than disciplined.
- The **host** wraps the srcdoc server-side (`server/workspace/collections/remoteView.ts`
  → `buildRemoteView`); the phone and the desktop preview both receive the same
  finished artifact.
- CSP is **stricter than desktop**: `connect-src 'none'` — data arrives via
  postMessage, so the view needs no network channel and the fetch/XHR/beacon
  exfil surface disappears.
- **1 MiB budget.** The srcdoc travels inside a Firestore command document
  (1 MiB cap), so the builder enforces `REMOTE_VIEW_MAX_BYTES` (~900 KB) and
  throws a byte-count error the agent can act on. The desktop preview surfaces
  the size as a caption while iterating.
- **Preview == phone capability, exactly.** The desktop preview answers only the
  same messages the phone runtime does (`mc-remote-get-items`, `mc-start-chat`),
  so "works in preview" stays meaningful.

Authoring spec for the agent: `packages/core/assets/helps/custom-view-remote.md`.
Register a mobile view with a `target` discriminator:

```jsonc
"views": [
  { "id": "phone", "label": "Phone", "target": "mobile", "file": "views/phone.html" }
]
```

Absent `target` means `desktop`, so every existing view keeps its exact behavior.

---

## Chat with image attachments

`startChat` seeds a visible chat from the phone: the verbatim `message`, an
optional `role`, and optional `attachments`. Because a command doc can't carry
full-resolution bytes, images go through **Firebase Storage** as a staging area:

1. The remote uploads bytes to `users/{uid}/uploads/{storage_id}` (it holds
   read/delete rights there).
2. `startChat` → `ingestAttachments` downloads each staged object into the
   workspace via `saveAttachment` (110 MiB cap, `storage_id` regex-guarded),
   **deletes the staging object**, and returns path-only `Attachment[]`.
3. `spawnSystemWorker` starts the chat.

Storage is staging only. Two orphan safeguards (for uploads whose host never
ran): **remote-side rollback** — the remote best-effort deletes its own staged
objects if `startChat` never gets a host ack — and a **Storage lifecycle TTL**
backstop (follow-up, not v1). See `plans/done/feat-remote-chat-image-attachments.md`.

---

## Offline queueing (`startChat` while the host is asleep)

The command channel is a **durable Firestore queue**, so `startChat` doesn't need
the host awake *now*. A remote can write the command (and stage its attachments)
while the host is offline; the host **drains everything on reconnect** because the
runner's `onSnapshot` reports every pre-existing `queued` doc as an `added` change
the instant it re-attaches. No flush call, no separate channel — the same
`commands` subcollection, treated slightly differently on both ends. See
`plans/done/feat-remote-offline-queue.md`.

Three optional, backward-compatible fields on the command doc drive it (absent ⇒
today's exact behaviour):

```jsonc
{ "createdAt": 1751760000000,   // enqueue time (epoch ms) — replay ordering
  "expiresAt": 1752364800000,   // deadline (epoch ms) — past it the host deletes it
  "queuedOffline": true }       // emitted while the host was offline
```

- **Best-effort drain order.** The runner sorts each drained batch by `createdAt`
  **in memory** (oldest first) to bias which command starts first — but commands
  are processed concurrently and **out-of-order completion is by design** (chat is
  asynchronous), so this is not a strict ordering guarantee. In-memory rather than
  `orderBy("createdAt")` on the query because a Firestore `orderBy` silently
  excludes pre-offline-queue docs that have no `createdAt`.
- **Expiry ⇒ delete, not error.** A command past `expiresAt` is removed entirely:
  the runner calls the host's `onExpire(command)` — which deletes the staged
  attachment uploads (`server/remoteHost/onExpire.ts`) — then `deleteDoc`s it. It
  never reaches a handler and leaves no `error` doc. Both steps are
  best-effort/idempotent, so a snapshot replay of the same expired doc is
  harmless. (Contrast a command that *ran* and failed validation — e.g. a stale
  role — which keeps its `error` so the phone can explain it.)
- **Cleanup ownership.** Every staged upload now has a definite reaper — the host
  on ingest-success, the host on expiry, or the remote on user-delete — so the
  Storage lifecycle TTL drops to a last-resort backstop for the one case nobody
  covers: a host that never reconnects at all.
- **TTL-below-expiry invariant.** The `expiresAt` horizon **must be shorter than**
  the Storage lifecycle TTL, or a still-valid queued command could find its staged
  attachment already swept. Chosen pair: **7-day expiry under a 14-day TTL.**
- **Protocol-gated.** Offline queueing requires the host to honour `expiresAt`, so
  it is advertised via `protocolVersion` (v2). A remote MUST see `protocolVersion
  >= 2` in the presence doc before queueing offline — a v1 host would ignore
  `expiresAt` and spawn stale chats on reconnect with uploads never cleaned up.
- The remote lists its own `queued` commands and can **delete** one before the
  host drains it (doc + staged uploads), and exempts `queuedOffline` commands from
  its ack-timeout rollback (that cleanup is now the host's / user's job). These
  are the mulmoserver-client half.

---

## Web Push on task finish (#2086)

When you ask a question, step away, and want a ping the moment the answer is ready,
enable **Settings → Notifications → Web Push**. On every **human-initiated** turn
completion the host calls the separate `mulmoserver` `sendPush` Cloud Function, which
delivers a push to your registered devices — so it works even with the browser tab
closed, as long as the host machine is up.

- **Sender only.** MulmoClaude hands `{ title, body }` to the shared
  [`@mulmobridge/web-push`](../packages/web-push) package (`server/agent/webPush.ts`),
  which POSTs it to `sendPush` in the onCall envelope `{ "data": { title, body } }`.
  Device registration, the PWA, VAPID keys, delivery, and dead-token pruning all live
  in `mulmoserver` (`docs/web-push-sending.md`, mulmoserver#46).
- **Auth = this RemoteHost session.** `sendPush` needs the signed-in user's Firebase
  ID token (`session.ts` `currentIdToken()`). So push only fires **while RemoteHost is
  connected**: with it disconnected there's no ID token, so the send is a silent no-op
  (never hits the network). Connected but with no device registered, the send *does* run
  and `sendPush` returns `targets: 0` — the call succeeds but no notification is delivered.
- **Scope.** Only human-initiated turns (`origin === human`). Scheduler / skill / bridge /
  hidden-system turns don't push — the point is "notify me about the answer I'm waiting
  for", not background chores. Off by default (`AppSettings.pushEnabled`).

**One-time user setup** (mulmoserver side): generate the VAPID key pair in the Firebase
Console, add the PWA to your phone's home screen, and grant notification permission. See
mulmoserver `docs/web-push.md`.

---

## API surface (`server/api/routes/remoteHost.ts`)

Bearer-guarded loopback routes (paths under `API_ROUTES.remoteHost` in
`src/config/apiRoutes.ts`). These start/stop the Firestore host loop — they are
**not** the command channel itself:

| Route | Body | Returns |
|---|---|---|
| `POST /api/remote-host/connect` | `{ idToken }` | `{ status }` — signs in + starts the runner (idToken never logged) |
| `POST /api/remote-host/disconnect` | — | `{ status }` — stops the runner + signs out |
| `GET /api/remote-host/status` | — | `{ status }` where `status = { connected, uid }` |

---

## Frontend

- **`src/composables/useRemoteHost.ts`** — shared module-scoped store for the
  connection state (one singleton for both the toolbar control and the offline
  banner). It **polls** `/status` every 15 s and, when a session blob is parked
  (the user intended to be connected) but the host is disconnected, **silently
  auto-reconnects** from the parked blob — so a server restart or a server-side
  listener death recovers within one interval instead of only when the popover is
  opened. Pure decision rules (`shouldAutoReconnect`, `shouldShowRemoteHostBanner`)
  live in **`src/composables/remoteHostDecisions.ts`** (unit-tested without Firebase).
- **`src/components/RemoteHostControl.vue`** — the toolbar `phonelink` button
  (green when connected) with a popover showing online/offline, uid, and
  Connect/Disconnect. Connect runs the browser Google sign-in, extracts the
  `idToken`, and `apiPost`s to `/connect`. Consumes `useRemoteHost`; starts/stops
  the poll loop on mount/unmount. Popover help text links the mobile URL
  `https://mulmoserver.web.app` and hints at custom remote views.
- **`src/components/RemoteHostOfflineBanner.vue`** (#2535) — a persistent banner
  (mounted in `App.vue` next to `BackendOfflineBanner`) shown only when the host
  was meant to be connected but dropped and a silent auto-reconnect couldn't
  restore it (e.g. the parked blob expired → needs a Google popup). Its Reconnect
  button re-runs sign-in. Gated on `shouldShowRemoteHostBanner` so it doesn't flap
  during a normal quick restart.
- **`src/components/SidebarHeader.vue`** — mounts `<RemoteHostControl />` in the
  toolbar chrome row.
- **`src/config/firebaseConfig.ts`** (pure public web config, source of truth) +
  **`src/config/firebase.ts`** (browser SDK init) — project `mulmoserver`.
- i18n keys `remoteHost.*` and `remoteHostOffline.*` across all `src/lang/*` locales.

There is **no in-app remote-view renderer** in this repo — mobile views render on
the external mulmoserver client. The desktop side only builds a *preview* of a
mobile view inside a phone-sized (390×844) sandboxed iframe in the collection's
view selector.

---

## Roadmap / provenance

Every phase's **host** side is shipped in this repo (rows marked _(planned)_ are
designed but not yet built); the outstanding half each names is the external
mulmoserver client (which depends on the published `@mulmoclaude/core` contract).
Design rationale lives in the plan files:

| Plan | Phase / feature |
|---|---|
| `plans/done/feat-remote-host-firestore-list-collections.md` | Phase 1 — channel + auth + hostRunner + `listCollections` |
| `plans/feat-remote-collection-view.md` | Phase 2 — `getCollection` / paged records |
| `plans/done/feat-remote-custom-view.md` | Phase 3 — `getRemoteView` sandboxed srcdoc + postMessage bridge |
| `plans/done/feat-remote-writable-view.md` | Phase 4 — `mutateRemoteViewItem` (host-enforced policy) |
| `plans/done/feat-remote-view-images.md` | Phase 5 — `getRemoteViewItems` image thumbnails |
| `plans/done/feat-remote-chat-image-attachments.md` | `startChat` attachments + `ingestAttachments` |
| `plans/done/feat-1955-remote-host-help.md` | Popover help text + mobile URL link |
| `plans/done/feat-remote-host-capabilities.md` | Capability advertisement in the presence doc (`HostPresence`, `protocolVersion`) |
| `plans/done/feat-remote-offline-queue.md` | _(planned)_ Queue `startChat` while the host is offline — drain on reconnect, `expiresAt` + host-side expiry delete (doc + attachments), user-managed pending list |

> **Not to be confused with** MulmoBridge's "relay" (a Cloudflare Workers message
> relay — see `docs/message_apps/relay/`). That is a separate messaging feature;
> the remote-host relay is Firestore itself.
