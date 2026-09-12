// Regression test for #3089: a session parked by the browser while a LATER
// Firebase app was live (`remote-host-2`, …) must still restore on a restarted
// host, whose first `open` builds `remote-host-1`. Firebase Auth looks the
// stored user up under `firebase:authUser:<apiKey>:<its own app name>`, so
// before the fix the lookup missed and `authStateReady()` settled with no user
// — the host answered 401 and the browser dropped the parked session.
//
// This drives the real firebase/auth restore path with no network and no real
// credentials: `globalThis.fetch` is replaced BEFORE firebase is loaded, because
// @firebase/auth captures the global in `FetchProvider.initialize(fetch, …)` at
// module-eval time. Every auth API call then fails as `network-request-failed`,
// which is the ONE error the SDK answers by keeping the stored user rather than
// signing it out (`reloadAndSetCurrentUserOrClear`). That is why this lives in
// its own file: `test_session.ts` imports firebase statically, so the stub could
// not be installed first there.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The stub RESOLVES with an unparsable body rather than rejecting. Both end in
// `network-request-failed`, but `_performFetchWithErrorHandling` races the fetch
// against a 30-second `NetworkTimeout` and clears that timer only after the race
// RESOLVES — a rejecting stub leaves it pending and the test process idles for 30
// seconds before exiting. Resolving gets the timer cleared, then `response.json()`
// throws and the SDK reports the network error the restore path needs.
const fetchCalls: string[] = [];
globalThis.fetch = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
  fetchCalls.push(String(input).split("?")[0] ?? "");
  return Promise.resolve(new Response("offline (test stub): not json"));
};

const { createRemoteHostSession } = await import("../../src/remote-host/server/firebase.js");
const { updateCurrentUser } = await import("firebase/auth");

const CONFIG = { apiKey: "test-api-key", authDomain: "test.firebaseapp.com", projectId: "test", appId: "1:0:web:test" };
const UID = "parked-uid";
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

// Shaped like what `UserImpl.toJSON()` writes; `_fromJSON` asserts on these
// fields. The `appName` INSIDE the user is written by the SDK but never read
// back, so leaving it stale is deliberate — only the key has to line up.
const blobFor = (appName: string, uid: string = UID): string =>
  JSON.stringify({
    [`firebase:authUser:${CONFIG.apiKey}:${appName}`]: {
      uid,
      emailVerified: false,
      isAnonymous: false,
      providerData: [],
      stsTokenManager: { refreshToken: "parked-refresh", accessToken: "parked-access", expirationTime: Date.now() + TOKEN_LIFETIME_MS },
      createdAt: "0",
      lastLoginAt: "0",
      apiKey: CONFIG.apiKey,
      appName,
    },
  });

describe("createRemoteHostSession.open (restore a parked blob after a restart)", () => {
  it("restores a blob parked under a later app name on the first open (#3089)", async () => {
    const session = createRemoteHostSession(CONFIG);
    try {
      const opened = await session.open(blobFor("remote-host-2"));
      assert.equal(opened.uid, UID, "a blob parked under remote-host-2 must restore into the first app of a fresh process");
      assert.ok(
        fetchCalls.some((url) => url.endsWith("accounts:lookup")),
        "the SDK only reloads a user it actually found in persistence",
      );
    } finally {
      await session.close();
    }
  });

  it("restores a blob parked under the same app name it reopens with (control)", async () => {
    const session = createRemoteHostSession(CONFIG);
    try {
      const opened = await session.open(blobFor("remote-host-1"));
      assert.equal(opened.uid, UID);
    } finally {
      await session.close();
    }
  });

  it("restores across an in-process reconnect, where the app name always moves on", async () => {
    // The self-heal path: a live session hands its own parked blob back to
    // `open`, which must build a DIFFERENT app (the previous one is still live
    // and `initializeAuth` runs once per app) — so the blob's app name can never
    // match there either.
    const session = createRemoteHostSession(CONFIG);
    try {
      const first = await session.open(blobFor("remote-host-1"));
      assert.equal(first.auth.app.name, "remote-host-1");

      const parked = session.exportSession();
      assert.ok(parked);
      const second = await session.open(parked);
      assert.equal(second.auth.app.name, "remote-host-2", "a reconnect must open a fresh app");
      assert.equal(second.uid, UID);
    } finally {
      await session.close();
    }
  });

  it("refuses to restore a blob that carries two app names, instead of adopting the stale one", async () => {
    // `open` keeps the previous app alive until the fresh one validates, and both
    // apps share one store — so a write from the previous app during that window
    // parks a blob holding BOTH names. `validate` runs inside exactly that window,
    // which is how this drives it without waiting for a real token refresh.
    const session = createRemoteHostSession(CONFIG);
    const parked = await (async () => {
      try {
        const first = await session.open(blobFor("remote-host-1", "stale-uid"));
        await session.open(blobFor("remote-host-9", "current-uid"), async () => {
          if (first.auth.currentUser) await updateCurrentUser(first.auth, first.auth.currentUser);
        });
        return session.exportSession();
      } finally {
        await session.close();
      }
    })();
    assert.equal(Object.keys(JSON.parse(parked ?? "{}")).length, 2, "the window must actually have produced a two-name blob");

    const restarted = createRemoteHostSession(CONFIG);
    try {
      const opened = await restarted.open(parked ?? "{}");
      assert.equal(opened.uid, null, "an ambiguous blob must restore nobody — never the account the user signed out of");
    } finally {
      await restarted.close();
    }
  });

  it("re-exports the restored session under the app that is now live", async () => {
    const session = createRemoteHostSession(CONFIG);
    try {
      await session.open(blobFor("remote-host-2"));
      const exported: unknown = JSON.parse(session.exportSession() ?? "null");
      assert.ok(exported && typeof exported === "object");
      assert.deepEqual(Object.keys(exported), [`firebase:authUser:${CONFIG.apiKey}:remote-host-1`]);
    } finally {
      await session.close();
    }
  });
});
