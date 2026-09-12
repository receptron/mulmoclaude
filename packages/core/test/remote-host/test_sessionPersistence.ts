// Unit tests for the export/seed-able Firebase Auth persistence
// (createHostSessionPersistence) that lets a host's session be parked in the
// browser and restored after a restart (mulmoserver#50, case A').
//
// The headline test is the regression guard: the persistence MUST be a class the
// SDK can `new`, not a plain object — a plain object throws "Expected a class
// definition" inside `initializeAuth` → `_getInstance`. That path is exercised by
// real firebase here (offline: initializeApp + initializeAuth need no network).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deleteApp, initializeApp } from "firebase/app";
import { initializeAuth } from "firebase/auth";

import { createHostSessionPersistence, isSeedableBlob } from "../../src/remote-host/server/sessionPersistence.js";

const CONFIG = { apiKey: "test", projectId: "test", appId: "test" };
const AUTH_KEY = "firebase:authUser:apiKey:remote-host-1";
const userValue = { uid: "u1", stsTokenManager: { refreshToken: "rt" } };

let appSeq = 0;
const freshApp = () => {
  appSeq += 1;
  return initializeApp(CONFIG, `sp-test-${appSeq}`);
};

describe("createHostSessionPersistence", () => {
  it("is accepted by initializeAuth — it's a class, not an object (regression)", async () => {
    // Guards the bug where passing a plain object threw
    // "INTERNAL ASSERTION FAILED: Expected a class definition" in _getInstance,
    // breaking createRemoteHostSession.open() for real.
    const app = freshApp();
    try {
      const { persistence } = createHostSessionPersistence();
      assert.doesNotThrow(() => initializeAuth(app, { persistence }));
    } finally {
      await deleteApp(app);
    }
  });

  it("advertises itself as durable (LOCAL) and available so the SDK persists the user", async () => {
    const { persistence } = createHostSessionPersistence();
    assert.equal(persistence.type, "LOCAL"); // static — the Persistence type bridge
    const instance = new persistence();
    assert.equal(instance.type, "LOCAL"); // instance — what the SDK reads after `new`
    assert.equal(await instance._isAvailable(), true);
  });

  it("_set / _get / _remove round-trip a value", async () => {
    const { persistence } = createHostSessionPersistence();
    const instance = new persistence();
    assert.equal(await instance._get(AUTH_KEY), null);
    await instance._set(AUTH_KEY, userValue);
    assert.deepEqual(await instance._get(AUTH_KEY), userValue);
    await instance._remove(AUTH_KEY);
    assert.equal(await instance._get(AUTH_KEY), null);
  });

  it("instances share the factory's store (a fresh `new` still sees live data)", async () => {
    const { persistence } = createHostSessionPersistence();
    await new persistence()._set(AUTH_KEY, userValue);
    assert.deepEqual(await new persistence()._get(AUTH_KEY), userValue);
  });

  it("exportBlob is null when empty and JSON of the store otherwise", async () => {
    const { persistence, exportBlob } = createHostSessionPersistence();
    assert.equal(exportBlob(), null);
    await new persistence()._set(AUTH_KEY, userValue);
    assert.deepEqual(JSON.parse(exportBlob() ?? "null"), { [AUTH_KEY]: userValue });
  });

  it("seed restores contents from a blob before init, and export round-trips it", async () => {
    const source = createHostSessionPersistence();
    await new source.persistence()._set(AUTH_KEY, userValue);
    const blob = source.exportBlob();
    assert.ok(blob);

    const restored = createHostSessionPersistence();
    restored.seed(blob);
    assert.deepEqual(await new restored.persistence()._get(AUTH_KEY), userValue);
    assert.equal(restored.exportBlob(), blob);
  });

  it("seed replaces any existing contents (last-write-wins)", async () => {
    const { persistence, seed, exportBlob } = createHostSessionPersistence();
    await new persistence()._set("stale", "old");
    seed(JSON.stringify({ [AUTH_KEY]: userValue }));
    assert.equal(await new persistence()._get("stale"), null);
    assert.deepEqual(JSON.parse(exportBlob() ?? "null"), { [AUTH_KEY]: userValue });
  });

  it("seed re-keys a blob to the app about to be opened (#3089 regression)", async () => {
    // A blob parked while `remote-host-2` was live must restore into the
    // `remote-host-1` app a restarted host opens first: the SDK only ever looks
    // up the key built from ITS OWN app name.
    const { persistence, seed, exportBlob } = createHostSessionPersistence();
    seed(JSON.stringify({ "firebase:authUser:apiKey:remote-host-2": userValue }), "remote-host-1");

    assert.deepEqual(await new persistence()._get(AUTH_KEY), userValue);
    assert.deepEqual(JSON.parse(exportBlob() ?? "null"), { [AUTH_KEY]: userValue });
  });

  it("seed re-keys every Firebase-shaped key and leaves other keys alone", () => {
    const { seed, exportBlob } = createHostSessionPersistence();
    seed(
      JSON.stringify({
        "firebase:authUser:apiKey:remote-host-9": userValue,
        "firebase:persistence:apiKey:remote-host-9": "LOCAL",
        "not-a-firebase-key": "keep",
        "firebase:authUser:api:Key:with:colons": "keep", // too many segments to read safely
      }),
      "remote-host-1",
    );

    assert.deepEqual(JSON.parse(exportBlob() ?? "null"), {
      "firebase:authUser:apiKey:remote-host-1": userValue,
      "firebase:persistence:apiKey:remote-host-1": "LOCAL",
      "not-a-firebase-key": "keep",
      "firebase:authUser:api:Key:with:colons": "keep",
    });
  });

  it("seed without an app name restores keys verbatim (the rollback path)", () => {
    // `open` rolls back to a still-live app, which reads the keys its own blob
    // already carries — re-keying there would hide its session from it.
    const { seed, exportBlob } = createHostSessionPersistence();
    const parked = JSON.stringify({ "firebase:authUser:apiKey:remote-host-2": userValue });
    seed(parked);
    assert.equal(exportBlob(), parked);
  });

  it("seed rejects a non-object blob", () => {
    const { seed } = createHostSessionPersistence();
    assert.throws(() => seed("[1,2,3]"), /must be a JSON object/);
    assert.throws(() => seed('"a string"'), /must be a JSON object/);
    assert.throws(() => seed("not json"));
  });

  it("onChange fires with the fresh blob on set and remove, and stops after unsubscribe", async () => {
    const { persistence, onChange } = createHostSessionPersistence();
    const instance = new persistence();
    const seen: (string | null)[] = [];
    const unsubscribe = onChange((blob) => seen.push(blob));

    await instance._set(AUTH_KEY, userValue);
    await instance._remove(AUTH_KEY);
    assert.equal(seen.length, 2);
    assert.deepEqual(JSON.parse(seen[0] ?? "null"), { [AUTH_KEY]: userValue });
    assert.equal(seen[1], null); // removing the last key → empty → null (tells the browser to drop it)

    unsubscribe();
    await instance._set(AUTH_KEY, userValue);
    assert.equal(seen.length, 2); // no further notifications
  });

  it("isSeedableBlob accepts a JSON object and rejects malformed / non-object blobs", () => {
    // Anything false here can never restore a session → the client should drop
    // it (treated as expired), not retry it forever.
    assert.equal(isSeedableBlob(JSON.stringify({ [AUTH_KEY]: userValue })), true);
    assert.equal(isSeedableBlob("{}"), true);
    assert.equal(isSeedableBlob("[1,2,3]"), false); // valid JSON, not an object
    assert.equal(isSeedableBlob('"a string"'), false);
    assert.equal(isSeedableBlob("not json"), false);
    assert.equal(isSeedableBlob(""), false);
  });

  it("clear empties the store without firing onChange", async () => {
    const { persistence, onChange, clear, exportBlob } = createHostSessionPersistence();
    const seen: (string | null)[] = [];
    onChange((blob) => seen.push(blob));
    await new persistence()._set(AUTH_KEY, userValue);
    seen.length = 0;

    clear();
    assert.equal(exportBlob(), null);
    assert.equal(seen.length, 0);
  });
});
