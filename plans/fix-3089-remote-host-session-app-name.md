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

### Rejected alternative

Wrapping the blob in a core-owned envelope that records the app name, then opening the first app
under that name. It keeps the "never interpret the blob" rule, but does not fix in-process
reconnect (the previous app still holds that name) and drops one session for every blob already
parked in a browser.

## Tests

1. `packages/core/test/remote-host/test_sessionPersistence.ts` — pure: `seed(blob, "remote-host-1")`
   re-keys `firebase:authUser:<api>:remote-host-2`, leaves non-Firebase-shaped keys alone, and
   `seed(blob)` (no app name) still restores verbatim.
2. `packages/core/test/remote-host/test_sessionRestore.ts` (new file) — the regression from the
   issue, end-to-end through real `firebase/auth`: a blob whose key names `remote-host-2` handed
   to a fresh `createRemoteHostSession`'s FIRST `open` returns the uid; the control (`remote-host-1`,
   which worked before); the in-process reconnect; and the re-export carrying the now-live name.
   `globalThis.fetch` is replaced BEFORE firebase loads (`@firebase/auth` captures the global in
   `FetchProvider.initialize` at module eval), so no network and no real credentials are touched;
   the auth API calls fail as `network-request-failed`, which Firebase treats as "keep the stored
   user". Needs its own file because the existing `test_session.ts` imports firebase statically.

## Verification

- With the two source files stashed, `test_sessionRestore.ts` is 1 pass / 3 fail — the failing
  one reports exactly the issue's symptom (`uid` null for a `remote-host-2` blob). With the fix,
  4/4 pass and the whole of `packages/core/test/remote-host` is 163/163.
- `eslint src/remote-host test/remote-host` → 0 errors (2 pre-existing warnings in
  `src/remote-host/index.ts`); `tsc --noEmit` clean.
- Build is left to CI: the host was at load average ~31 and the change adds no import or build
  input.
- Real-environment check by the reporter, with a MulmoTerminal carrying the fixed core (needs a
  `@mulmoclaude/core` publish, which is NOT part of this PR): after a `Disconnect → Connect`
  within one run, a host restart must stay Online.
