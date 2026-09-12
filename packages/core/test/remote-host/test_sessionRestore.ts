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
// which the SDK treats as "keep the stored user" rather than "sign out". That is
// why this lives in its own file: `test_session.ts` imports firebase statically,
// so the stub could not be installed first there.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const fetchCalls: string[] = [];
globalThis.fetch = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
  fetchCalls.push(String(input).split("?")[0] ?? "");
  return Promise.reject(new TypeError("offline (test stub)"));
};

const { createRemoteHostSession } = await import("../../src/remote-host/server/firebase.js");

const CONFIG = { apiKey: "test-api-key", authDomain: "test.firebaseapp.com", projectId: "test", appId: "1:0:web:test" };
const UID = "parked-uid";
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

// Shaped like what `UserImpl.toJSON()` writes; `_fromJSON` asserts on these
// fields. The `appName` INSIDE the user is written by the SDK but never read
// back, so leaving it stale is deliberate — only the key has to line up.
const blobFor = (appName: string): string =>
  JSON.stringify({
    [`firebase:authUser:${CONFIG.apiKey}:${appName}`]: {
      uid: UID,
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
