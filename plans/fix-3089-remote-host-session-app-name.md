# fix(remote-host): a parked session saved under `remote-host-2` or later cannot be restored

Issue: receptron/mulmoclaude#3089

## Problem

`createRemoteHostSession` (`packages/core/src/remote-host/server/firebase.ts`) opens a FRESH
Firebase app on every `open`, named `remote-host-${appSeq}` where `appSeq` counts opens within
the current process (failed ones included) and resets to 0 on restart.

`@firebase/auth` namespaces every persistence key with the app that wrote it —
`_persistenceKeyName` builds `firebase:<key>:<apiKey>:<appName>`. So the blob the browser parks
(`exportSession()`) carries the app name that was live when it was written.

`sessionPersistence.seed` stores the blob's keys verbatim. When the parked blob says
`remote-host-2` and the restarted host's first `open` builds the `remote-host-1` app, the SDK
looks up its OWN key, misses, and `authStateReady()` settles with `currentUser === null`. The
host's `restore` then throws `RemoteHostSessionExpiredError` → `/api/remote-host/reconnect`
answers 401 → the browser drops the parked blob and the user has to sign in with the Google
popup again.

Once in that state it is self-sustaining: the failed restore has already advanced `appSeq`, so
the re-sign-in is saved under `remote-host-2` again.

The same mismatch also breaks in-process reconnect (self-heal): `open` #N+1 is always named
differently from the app whose keys the blob carries.

## Fix

Re-key the blob at seed time to the app that is about to be opened.

- `sessionPersistence.seed(blob, appName?)` — when `appName` is given, rewrite the app-name
  segment of every key shaped `firebase:<key>:<apiKey>:<appName>` (exactly 4 colon-separated
  segments, first segment `firebase`). Anything else passes through untouched.
- `firebase.ts` `openInner` passes the name it is about to open with. The rollback path keeps
  seeding verbatim — the previous app is still live and reads its own keys.

Only key NAMES are interpreted; the serialized user stays opaque. `UserImpl._fromJSON` does not
read the `appName` field inside the user JSON, so it needs no rewriting (verified against
@firebase/auth 1.13.3).

Backwards compatible: blobs already parked under `remote-host-2` restore after the fix without
the user signing in again.

### The re-key must refuse to guess (found in review, not in the issue)

A blob CAN carry two app names. `openInner` calls `store.clear()`, then awaits `openFreshApp`
AND `validate` — a full Google sign-in round trip on the `signIn` path — and only then deletes
`previousApp`. Throughout that window the previous app is live, holds a persistence instance
bound to the SAME store, and writes `firebase:authUser:<apiKey>:remote-host-<prev>` back on any
token refresh. Re-keying both onto one target picks a winner by JSON order, and the stale app is
the one that writes last — so a restart could come back as the account the user had just signed
out of. Reproduced: `open#1` as OLD-account, `open#2` as NEW-account with a write from the
previous app during `validate`, restart → `uid: OLD-account`. Pre-fix that same blob at a higher
sequence restores nobody, which is safe, so the re-key would have turned a safe session loss
into adopting the wrong account, on the auth boundary.

`resolveKeys` therefore drops any target that more than one source key claims: the restore finds
no user, `restore` throws `RemoteHostSessionExpiredError`, the route answers 401, the client
drops the blob and the user signs in once — the behaviour that existed before re-keying. The
underlying window is pre-existing and deliberate (the non-destructive reconnect contract of
#2076); this PR makes its failure mode safe rather than removing the window.

### Rejected alternative

Wrapping the blob in a core-owned envelope that records the app name, then opening the first app
under that name. It keeps the "never interpret the blob" rule, but does not fix in-process
reconnect (the previous app still holds that name) and drops one session for every blob already
parked in a browser.

## Tests

1. `packages/core/test/remote-host/test_sessionPersistence.ts` — pure: `seed(blob, "remote-host-1")`
   re-keys `firebase:authUser:<api>:remote-host-2`, leaves non-Firebase-shaped keys alone, drops a
   target two source keys claim, and `seed(blob)` (no app name) still restores verbatim.
2. `packages/core/test/remote-host/test_sessionRestore.ts` (new file) — the regression from the
   issue, end-to-end through real `firebase/auth`: a blob whose key names `remote-host-2` handed
   to a fresh `createRemoteHostSession`'s FIRST `open` returns the uid; the control (`remote-host-1`,
   which worked before); the in-process reconnect; the two-app-name blob that must restore
   nobody rather than the stale account; and the re-export carrying the now-live name.
   `globalThis.fetch` is replaced BEFORE firebase loads (`@firebase/auth` captures the global in
   `FetchProvider.initialize` at module eval), so no network and no real credentials are touched;
   the auth API calls fail as `network-request-failed`, which Firebase treats as "keep the stored
   user". Needs its own file because the existing `test_session.ts` imports firebase statically.

## Verification

- With the two source files stashed, `test_sessionRestore.ts` is 1 pass / 3 fail — the failing
  one reports exactly the issue's symptom (`uid` null for a `remote-host-2` blob). With the fix,
  the whole of `packages/core/test/remote-host` is 166/166.
- The ambiguity guard is break-verified on its own: removing `resolveKeys`' contested-target drop
  turns exactly the two tests that cover it red (18 pass / 2 fail) and leaves the rest green.
- `eslint src/remote-host test/remote-host` → 0 errors (2 pre-existing warnings in
  `src/remote-host/index.ts`); `tsc --noEmit` clean.
- Build is left to CI: the host was at load average ~31 and the change adds no import or build
  input.
- Real-environment check by the reporter, with a MulmoTerminal carrying the fixed core (needs a
  `@mulmoclaude/core` publish, which is NOT part of this PR): after a `Disconnect → Connect`
  within one run, a host restart must stay Online.
