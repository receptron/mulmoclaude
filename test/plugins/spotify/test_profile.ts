// Tests for the profile cache (PR 3). The cache backs the
// Premium-gate decision; getting the TTL or fallback semantics
// wrong has user-visible consequences (Free users locked into
// Premium UI or Premium users blocked from controls).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getProfile, isPremium } from "../../../packages/plugins/spotify-plugin/src/profile.js";
import type { SpotifyTokens } from "../../../packages/plugins/spotify-plugin/src/types.js";

const NOW_DATE = new Date("2026-05-05T00:00:00.000Z");
const NOW = () => NOW_DATE;
const CACHE_VERSION = 2;

const validTokens: SpotifyTokens = {
  accessToken: "at-current",
  refreshToken: "rt-current",
  expiresAt: "2026-05-05T05:00:00.000Z",
  scopes: ["user-library-read"],
};

function makeFakeRuntime(responses: Response[], initialFiles: Record<string, string> = {}) {
  const calls: { url: string }[] = [];
  const queue = [...responses];
  const store = new Map<string, string>(Object.entries(initialFiles));
  return {
    runtime: {
      fetch: async (url: string) => {
        calls.push({ url });
        const next = queue.shift();
        if (!next) throw new Error(`fetch over-called`);
        return next;
      },
      files: {
        config: {
          exists: async (rel: string) => store.has(rel),
          read: async (rel: string) => {
            const value = store.get(rel);
            if (value === undefined) throw new Error("not found");
            return value;
          },
          readBytes: async () => new Uint8Array(),
          write: async (rel: string, content: string | Uint8Array) => {
            store.set(rel, typeof content === "string" ? content : new TextDecoder().decode(content));
          },
          readDir: async () => Array.from(store.keys()),
          stat: async () => ({ mtimeMs: 0, size: 0 }),
          unlink: async (rel: string) => {
            store.delete(rel);
          },
        },
        data: {
          exists: async () => false,
          read: async () => "",
          readBytes: async () => new Uint8Array(),
          write: async () => {},
          readDir: async () => [],
          stat: async () => ({ mtimeMs: 0, size: 0 }),
          unlink: async () => {},
        },
      },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      pubsub: { publish: () => {} },
      locale: "en",
      fetchJson: async () => {
        throw new Error("not used");
      },
    },
    calls,
    store,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("getProfile — fresh fetch + cache write", () => {
  it("calls /v1/me when there's no cached snapshot, then persists profile.json", async () => {
    const handle = makeFakeRuntime([jsonResponse({ product: "premium", display_name: "Test User" })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getProfile({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.profile.product, "premium");
    assert.equal(result.profile.displayName, "Test User");
    const [profileCall] = handle.calls;
    assert.ok(profileCall);
    assert.equal(profileCall.url, "https://api.spotify.com/v1/me");
    // profile.json should be written.
    assert.ok(handle.store.has("profile.json"));
  });

  it("treats Free / Open accounts as non-premium", async () => {
    const handle = makeFakeRuntime([jsonResponse({ product: "free", display_name: "Free User" })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getProfile({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    if (!result.ok) throw new Error("unreachable");
    assert.equal(isPremium(result.profile), false);
  });
});

describe("getProfile — a /v1/me without `product`", () => {
  it("records the tier as unknown, not Free", async () => {
    const handle = makeFakeRuntime([jsonResponse({ id: "u-1", display_name: "No Product" })]);
    const result = await getProfile({ runtime: handle.runtime as never, clientId: "cid", tokens: validTokens, now: NOW });
    assert.ok(result.ok);
    assert.equal(result.profile.product, null);
    assert.equal(isPremium(result.profile), null);
  });

  it("serves the unknown tier back from the cache it wrote", async () => {
    const handle = makeFakeRuntime([jsonResponse({ id: "u-1", display_name: "No Product" })]);
    const deps = { runtime: handle.runtime as never, clientId: "cid", tokens: validTokens, now: NOW };
    await getProfile(deps);
    const second = await getProfile(deps);
    assert.ok(second.ok);
    assert.equal(second.profile.product, null);
    assert.equal(handle.calls.length, 1);
  });

  it("re-fetches a fresh snapshot written before the cache marker, since its Free may be fabricated", async () => {
    const legacy = JSON.stringify({ userId: "u-1", product: "free", displayName: "Legacy", fetchedAtMs: NOW_DATE.getTime() - 1000 });
    const handle = makeFakeRuntime([jsonResponse({ id: "u-1", product: "premium", display_name: "Refetched" })], { "profile.json": legacy });
    const result = await getProfile({ runtime: handle.runtime as never, clientId: "cid", tokens: validTokens, now: NOW });
    assert.ok(result.ok);
    assert.equal(result.profile.product, "premium");
    assert.equal(handle.calls.length, 1);
  });
});

describe("getProfile — cache hit", () => {
  it("does not call /v1/me when cache is fresh (within TTL)", async () => {
    const fresh = JSON.stringify({ cacheVersion: CACHE_VERSION, product: "premium", displayName: "Cached", fetchedAtMs: NOW_DATE.getTime() - 1000 });
    const handle = makeFakeRuntime([], { "profile.json": fresh });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getProfile({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.profile.displayName, "Cached");
    assert.equal(handle.calls.length, 0); // no fetch
  });

  it("re-fetches when cache is older than the TTL (24h)", async () => {
    const stale = JSON.stringify({
      cacheVersion: CACHE_VERSION,
      product: "premium",
      displayName: "Stale",
      fetchedAtMs: NOW_DATE.getTime() - 25 * 60 * 60 * 1000,
    });
    const handle = makeFakeRuntime([jsonResponse({ product: "free", display_name: "Refreshed" })], { "profile.json": stale });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getProfile({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.profile.product, "free");
    assert.equal(result.profile.displayName, "Refreshed");
    assert.equal(handle.calls.length, 1);
  });
});

describe("getProfile — fallback to stale cache on API failure", () => {
  it("returns the stale cache when /v1/me fails (network blip shouldn't block users)", async () => {
    const stale = JSON.stringify({
      cacheVersion: CACHE_VERSION,
      product: "premium",
      displayName: "Stale",
      fetchedAtMs: NOW_DATE.getTime() - 25 * 60 * 60 * 1000,
    });
    const handle = makeFakeRuntime([new Response("server err", { status: 500 })], { "profile.json": stale });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getProfile({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.profile.product, "premium"); // stale, but better than nothing
  });

  it("returns the API error when there's no cache to fall back on", async () => {
    const handle = makeFakeRuntime([new Response("server err", { status: 500 })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getProfile({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.kind, "spotify_api_error");
  });
});

describe("getProfile — corrupted cache", () => {
  it("treats unparseable profile.json as a cache miss", async () => {
    const handle = makeFakeRuntime([jsonResponse({ product: "premium", display_name: "Re-fetched" })], { "profile.json": "{not-json" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getProfile({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.profile.displayName, "Re-fetched");
    assert.equal(handle.calls.length, 1);
  });

  it("treats a profile.json missing required fields as a cache miss", async () => {
    const handle = makeFakeRuntime([jsonResponse({ product: "premium" })], { "profile.json": JSON.stringify({ displayName: "missing-fetchedAtMs" }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getProfile({ runtime: handle.runtime as any, clientId: "cid", tokens: validTokens, now: NOW });
    if (!result.ok) throw new Error("unreachable");
    assert.equal(handle.calls.length, 1);
  });
});

describe("isPremium discriminator", () => {
  it("returns true only for product === 'premium'", () => {
    assert.equal(isPremium({ userId: "u", product: "premium", displayName: "", fetchedAtMs: 0 }), true);
    assert.equal(isPremium({ userId: "u", product: "free", displayName: "", fetchedAtMs: 0 }), false);
    assert.equal(isPremium({ userId: "u", product: "open", displayName: "", fetchedAtMs: 0 }), false);
    assert.equal(isPremium({ userId: "u", product: "PREMIUM", displayName: "", fetchedAtMs: 0 }), false); // case-sensitive
    assert.equal(isPremium({ userId: "u", product: null, displayName: "", fetchedAtMs: 0 }), null);
  });
});
