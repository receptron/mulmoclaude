// What each `manageSpotify` kind actually calls, and with which arguments.
// The engine is a stub — no runtime, no network, no config dir — which is the
// point: before the router took its dependencies through a context (#2583)
// every handler was a closure over the PluginRuntime, so the kind → call
// mapping was unreachable from a test and nothing checked it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeSpotifyDispatch, type SpotifyApi, type SpotifyDispatchContext } from "../../../packages/plugins/spotify-plugin/src/core/dispatch.js";
import { DispatchArgsSchema, SPOTIFY_KINDS, type DispatchArgs } from "../../../packages/plugins/spotify-plugin/src/schemas.js";
import { SPOTIFY_SCOPES } from "../../../packages/plugins/spotify-plugin/src/oauth.js";
import type { SpotifyClientResult } from "../../../packages/plugins/spotify-plugin/src/client.js";
import type {
  NormalisedDevice,
  NormalisedPlaylist,
  NormalisedTrack,
  PendingAuthorization,
  RecentlyPlayedItem,
  SearchResult,
  SpotifyProfile,
  SpotifyTokens,
} from "../../../packages/plugins/spotify-plugin/src/types.js";

const CLIENT_ID = "client-123";
const REDIRECT_URI = "http://127.0.0.1:8787/api/plugins/runtime/oauth-callback/spotify";
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize?stubbed=1";
const CODE_VERIFIER = "verifier-abc";
const CODE_CHALLENGE = "challenge-abc";
const STATE = "state-abc";

const TOKENS: SpotifyTokens = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresAt: "2026-08-01T00:00:00.000Z",
  scopes: ["user-library-read"],
};
const FRESH_TOKENS: SpotifyTokens = { ...TOKENS, accessToken: "at-fresh", scopes: ["user-library-read", "user-modify-playback-state"] };
const PENDING: PendingAuthorization = { codeVerifier: CODE_VERIFIER, redirectUri: REDIRECT_URI, createdAtMs: 0 };

const TRACK: NormalisedTrack = { id: "t-1", name: "Blue", artists: ["Joni"], album: "Blue", durationMs: 1000 };
const PLAYLIST: NormalisedPlaylist = { id: "p-1", name: "Focus", description: "", trackCount: 12 };
const RECENT_ITEM: RecentlyPlayedItem = { track: TRACK, playedAt: "2026-07-30T10:00:00.000Z" };
const DEVICE: NormalisedDevice = { id: "d-1", name: "Desktop", type: "Computer", isActive: true };

type ProfileResult = Awaited<ReturnType<SpotifyApi["getProfile"]>>;
const premiumProfile: SpotifyProfile = { userId: "u-1", product: "premium", displayName: "Ada", fetchedAtMs: 0 };
const freeProfile: SpotifyProfile = { ...premiumProfile, product: "free" };
const PREMIUM_RESULT: ProfileResult = { ok: true, profile: premiumProfile };
const FREE_RESULT: ProfileResult = { ok: true, profile: freeProfile };
const UNKNOWN_TIER_RESULT: ProfileResult = { ok: true, profile: { ...premiumProfile, product: null } };
const forbidden = (body: string): SpotifyClientResult<null> => ({ ok: false, error: { kind: "spotify_api_error", status: 403, body } });

const LIKED_RESULT: SpotifyClientResult<NormalisedTrack[]> = { ok: true, data: [TRACK] };
const PLAYLISTS_RESULT: SpotifyClientResult<NormalisedPlaylist[]> = { ok: true, data: [PLAYLIST] };
const RECENT_RESULT: SpotifyClientResult<RecentlyPlayedItem[]> = { ok: true, data: [RECENT_ITEM] };
const NOW_PLAYING_RESULT: SpotifyClientResult<NormalisedTrack | null> = { ok: true, data: TRACK };
const SEARCH_RESULT: SpotifyClientResult<SearchResult> = { ok: true, data: { tracks: [TRACK] } };
const PLAYER_RESULT: SpotifyClientResult<null> = { ok: true, data: null };
const DEVICES_RESULT: SpotifyClientResult<NormalisedDevice[]> = { ok: true, data: [DEVICE] };

/** A recorded call: the engine function's name followed by its arguments. */
type Call = unknown[];

interface SpyKit {
  /** Records every call and always answers `result`. */
  spy: <R>(name: string, result: R) => (...args: unknown[]) => Promise<R>;
  /** Same, for the engine calls that are synchronous (the PKCE helpers). */
  spySync: <R>(name: string, result: R) => (...args: unknown[]) => R;
  /** Records the call and then throws — for the token-exchange failure path. */
  spyThrows: (name: string, error: Error) => (...args: unknown[]) => Promise<never>;
}

const createRecorder = () => {
  const calls: Call[] = [];
  const spy =
    <R>(name: string, result: R) =>
    async (...args: unknown[]): Promise<R> => {
      calls.push([name, ...args]);
      return result;
    };
  const spySync =
    <R>(name: string, result: R) =>
    (...args: unknown[]): R => {
      calls.push([name, ...args]);
      return result;
    };
  const spyThrows =
    (name: string, error: Error) =>
    async (...args: unknown[]): Promise<never> => {
      calls.push([name, ...args]);
      throw error;
    };
  return { calls, spy, spySync, spyThrows };
};

/** A connected Premium account whose every call succeeds. Tests override only
 *  the one answer they are about. */
const connectedPremiumApi = ({ spy, spySync }: SpyKit): SpotifyApi => ({
  readClientConfig: spy("readClientConfig", { clientId: CLIENT_ID }),
  writeClientConfig: spy("writeClientConfig", undefined),
  readTokens: spy("readTokens", TOKENS),
  writeTokens: spy("writeTokens", undefined),
  clearProfileCache: spy("clearProfileCache", undefined),

  exchangeCodeForTokens: spy("exchangeCodeForTokens", FRESH_TOKENS),

  generateRandomToken: spySync("generateRandomToken", CODE_VERIFIER),
  deriveCodeChallenge: spy("deriveCodeChallenge", CODE_CHALLENGE),
  registerPendingAuthorization: spySync("registerPendingAuthorization", STATE),
  consumePendingAuthorization: spySync("consumePendingAuthorization", PENDING),
  buildAuthorizeUrl: spySync("buildAuthorizeUrl", AUTHORIZE_URL),

  getProfile: spy("getProfile", PREMIUM_RESULT),
  fetchLiked: spy("fetchLiked", LIKED_RESULT),
  fetchPlaylists: spy("fetchPlaylists", PLAYLISTS_RESULT),
  fetchPlaylistTracks: spy("fetchPlaylistTracks", LIKED_RESULT),
  fetchRecent: spy("fetchRecent", RECENT_RESULT),
  fetchNowPlaying: spy("fetchNowPlaying", NOW_PLAYING_RESULT),
  searchSpotify: spy("searchSpotify", SEARCH_RESULT),
  playerPlay: spy("playerPlay", PLAYER_RESULT),
  playerPause: spy("playerPause", PLAYER_RESULT),
  playerNext: spy("playerNext", PLAYER_RESULT),
  playerPrevious: spy("playerPrevious", PLAYER_RESULT),
  playerSeek: spy("playerSeek", PLAYER_RESULT),
  playerSetVolume: spy("playerSetVolume", PLAYER_RESULT),
  playerTransfer: spy("playerTransfer", PLAYER_RESULT),
  playerGetDevices: spy("playerGetDevices", DEVICES_RESULT),
});

const createStub = (buildOverrides: (kit: SpyKit) => Partial<SpotifyApi> = () => ({})) => {
  const { calls, spy, spySync, spyThrows } = createRecorder();
  const logged: Call[] = [];
  const published: Call[] = [];
  const kit: SpyKit = { spy, spySync, spyThrows };
  const api: SpotifyApi = { ...connectedPremiumApi(kit), ...buildOverrides(kit) };
  const context: SpotifyDispatchContext = {
    api,
    log: {
      info: (msg: string, data?: object) => {
        logged.push(["info", msg, data]);
      },
      error: (msg: string, data?: object) => {
        logged.push(["error", msg, data]);
      },
    },
    pubsub: {
      publish: (eventName: string, payload: unknown) => {
        published.push([eventName, payload]);
      },
    },
  };
  return { context, calls, logged, published };
};

/** Parses like the tool does, so a route's arguments must also be arguments
 *  the LLM (or the View) could actually send. */
const dispatch = async (rawArgs: unknown, buildOverrides?: (kit: SpyKit) => Partial<SpotifyApi>) => {
  const stub = createStub(buildOverrides);
  const result = await executeSpotifyDispatch(stub.context, DispatchArgsSchema.parse(rawArgs));
  return { result, calls: stub.calls, logged: stub.logged, published: stub.published };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Read one field off a dispatch result. The router returns `unknown` (the
 *  kinds answer different shapes), and `assert.partialDeepStrictEqual` is
 *  still experimental on the Node 22 leg of the CI matrix. */
const field = (result: unknown, key: string): unknown => (isRecord(result) ? result[key] : undefined);

/** Every authenticated call receives exactly this. */
const CREDENTIALS = { clientId: CLIENT_ID, tokens: TOKENS };
/** Reading the config dir precedes every authenticated kind. */
const LOAD_CREDENTIALS: Call[] = [["readClientConfig"], ["readTokens"]];

interface Route {
  args: DispatchArgs;
  calls: Call[];
}

const ROUTES: Route[] = [
  {
    args: { kind: "connect", redirectUri: REDIRECT_URI },
    calls: [
      ["readClientConfig"],
      ["generateRandomToken"],
      ["deriveCodeChallenge", CODE_VERIFIER],
      ["registerPendingAuthorization", CODE_VERIFIER, REDIRECT_URI],
      ["buildAuthorizeUrl", { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, scopes: SPOTIFY_SCOPES, state: STATE, codeChallenge: CODE_CHALLENGE }],
    ],
  },
  {
    args: { kind: "oauthCallback", code: "auth-code", state: STATE },
    calls: [
      ["consumePendingAuthorization", STATE],
      ["readClientConfig"],
      ["exchangeCodeForTokens", { code: "auth-code", clientId: CLIENT_ID, codeVerifier: CODE_VERIFIER, redirectUri: REDIRECT_URI }],
      ["writeTokens", FRESH_TOKENS],
      ["clearProfileCache"],
    ],
  },
  { args: { kind: "status" }, calls: [["readClientConfig"], ["readTokens"], ["getProfile", CREDENTIALS]] },
  { args: { kind: "diagnose" }, calls: [["readClientConfig"], ["readTokens"]] },
  { args: { kind: "configure", clientId: " client-999 " }, calls: [["writeClientConfig", { clientId: "client-999" }]] },
  { args: { kind: "liked" }, calls: [...LOAD_CREDENTIALS, ["fetchLiked", CREDENTIALS, 50]] },
  { args: { kind: "playlists" }, calls: [...LOAD_CREDENTIALS, ["fetchPlaylists", CREDENTIALS]] },
  {
    args: { kind: "playlistTracks", playlistId: "pl-1" },
    calls: [...LOAD_CREDENTIALS, ["fetchPlaylistTracks", CREDENTIALS, "pl-1", 100]],
  },
  { args: { kind: "recent" }, calls: [...LOAD_CREDENTIALS, ["fetchRecent", CREDENTIALS, 50]] },
  { args: { kind: "nowPlaying" }, calls: [...LOAD_CREDENTIALS, ["fetchNowPlaying", CREDENTIALS]] },
  {
    args: { kind: "search", query: "joni", types: ["track"], limit: 5 },
    calls: [...LOAD_CREDENTIALS, ["searchSpotify", CREDENTIALS, "joni", ["track"], 5]],
  },
  {
    args: { kind: "play", deviceId: "d-1", contextUri: "spotify:playlist:p-1" },
    calls: [
      ...LOAD_CREDENTIALS,
      ["getProfile", CREDENTIALS],
      ["playerPlay", CREDENTIALS, { deviceId: "d-1", contextUri: "spotify:playlist:p-1", trackUris: undefined }],
    ],
  },
  { args: { kind: "pause" }, calls: [...LOAD_CREDENTIALS, ["getProfile", CREDENTIALS], ["playerPause", CREDENTIALS, undefined]] },
  { args: { kind: "next" }, calls: [...LOAD_CREDENTIALS, ["getProfile", CREDENTIALS], ["playerNext", CREDENTIALS, undefined]] },
  { args: { kind: "previous" }, calls: [...LOAD_CREDENTIALS, ["getProfile", CREDENTIALS], ["playerPrevious", CREDENTIALS, undefined]] },
  {
    args: { kind: "seek", positionMs: 42_000, deviceId: "d-1" },
    calls: [...LOAD_CREDENTIALS, ["getProfile", CREDENTIALS], ["playerSeek", CREDENTIALS, 42_000, "d-1"]],
  },
  {
    args: { kind: "setVolume", volumePercent: 30 },
    calls: [...LOAD_CREDENTIALS, ["getProfile", CREDENTIALS], ["playerSetVolume", CREDENTIALS, 30, undefined]],
  },
  {
    args: { kind: "transferPlayback", deviceId: "d-2", play: true },
    calls: [...LOAD_CREDENTIALS, ["getProfile", CREDENTIALS], ["playerTransfer", CREDENTIALS, "d-2", true]],
  },
  // No `getProfile`: `getDevices` is read-only and works on Free accounts.
  { args: { kind: "getDevices" }, calls: [...LOAD_CREDENTIALS, ["playerGetDevices", CREDENTIALS]] },
];

describe("executeSpotifyDispatch routing", () => {
  for (const route of ROUTES) {
    it(`${route.args.kind} calls the engine it says it does`, async () => {
      const { calls } = await dispatch(route.args);
      assert.deepEqual(calls, route.calls);
    });
  }

  it("routes every kind the schema accepts", () => {
    const routed: string[] = ROUTES.map((route) => route.args.kind);
    const missing = Object.values(SPOTIFY_KINDS).filter((kind) => !routed.includes(kind));
    assert.deepEqual(missing, [], `kinds with no routing test: ${missing.join(", ")}`);
  });
});

describe("credential gates", () => {
  it("asks for a Client ID before touching Spotify", async () => {
    const { result, calls } = await dispatch({ kind: "liked" }, ({ spy }) => ({ readClientConfig: spy("readClientConfig", null) }));
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["readClientConfig"],
    );
    assert.equal(field(result, "error"), "client_id_missing");
    assert.equal(typeof field(result, "instructions"), "string");
  });

  it("asks the user to connect before touching Spotify", async () => {
    const { result, calls } = await dispatch({ kind: "liked" }, ({ spy }) => ({ readTokens: spy("readTokens", null) }));
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["readClientConfig", "readTokens"],
    );
    assert.deepEqual(result, { ok: false, error: "not_connected", message: "Spotify に未接続です。「Connect」を実行してください。" });
  });
});

describe("player gating", () => {
  it("refuses playback on a Free account without calling Spotify", async () => {
    const { result, calls } = await dispatch({ kind: "pause" }, ({ spy }) => ({ getProfile: spy("getProfile", FREE_RESULT) }));
    assert.equal(
      calls.some((call) => call[0] === "playerPause"),
      false,
    );
    assert.equal(field(result, "error"), "premium_required");
  });

  it("lets playback through when Spotify did not say which tier the account is on", async () => {
    // `/v1/me` omits `product` for Development Mode apps; a Premium account must not be refused.
    const { result, calls } = await dispatch({ kind: "pause" }, ({ spy }) => ({ getProfile: spy("getProfile", UNKNOWN_TIER_RESULT) }));
    assert.equal(
      calls.some((call) => call[0] === "playerPause"),
      true,
    );
    assert.equal(field(result, "ok"), true);
  });

  it("answers a Player API PREMIUM_REQUIRED 403 with the same refusal the gate gives", async () => {
    const premium403 = forbidden('{"error":{"status":403,"message":"Player command failed: Premium required","reason":"PREMIUM_REQUIRED"}}');
    const { result: refusedBySpotify } = await dispatch({ kind: "pause" }, ({ spy }) => ({
      getProfile: spy("getProfile", UNKNOWN_TIER_RESULT),
      playerPause: spy("playerPause", premium403),
    }));
    const { result: refusedByGate } = await dispatch({ kind: "pause" }, ({ spy }) => ({ getProfile: spy("getProfile", FREE_RESULT) }));
    assert.deepEqual(refusedBySpotify, refusedByGate);
  });

  it("still reads a scope 403 as a missing scope", async () => {
    const { result } = await dispatch({ kind: "pause" }, ({ spy }) => ({ playerPause: spy("playerPause", forbidden("Insufficient client scope")) }));
    assert.equal(field(result, "error"), "scope_missing");
  });

  it("lists devices on a Free account", async () => {
    // The View populates its device dropdown before the user upgrades, so
    // this one kind must skip the gate entirely.
    const { result, calls } = await dispatch({ kind: "getDevices" }, ({ spy }) => ({ getProfile: spy("getProfile", FREE_RESULT) }));
    assert.equal(
      calls.some((call) => call[0] === "getProfile"),
      false,
    );
    assert.deepEqual(result, { ok: true, message: "Devices (1):\n1. Desktop (Computer) — active", data: [DEVICE] });
  });

  it("rejects play with both a context and explicit tracks, before reading credentials", async () => {
    const { result, calls } = await dispatch({ kind: "play", contextUri: "spotify:playlist:p-1", trackUris: ["spotify:track:t-1"] });
    assert.deepEqual(calls, []);
    assert.deepEqual(result, {
      ok: false,
      error: "invalid_args",
      message: "play: `contextUri` と `trackUris` は同時に指定できません。どちらか一方を選んでください。",
    });
  });
});

describe("oauthCallback", () => {
  it("reports a denied authorization without consuming the pending state", async () => {
    const { result, calls } = await dispatch({ kind: "oauthCallback", error: "access_denied" });
    assert.deepEqual(calls, []);
    assert.equal(field(result, "error"), "auth_denied");
  });

  it("rejects a callback missing code or state", async () => {
    const { result } = await dispatch({ kind: "oauthCallback", state: STATE });
    assert.equal(field(result, "error"), "invalid_callback");
  });

  it("rejects a state it never issued", async () => {
    const { result, calls } = await dispatch({ kind: "oauthCallback", code: "auth-code", state: "forged" }, ({ spySync }) => ({
      consumePendingAuthorization: spySync("consumePendingAuthorization", null),
    }));
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["consumePendingAuthorization"],
    );
    assert.equal(field(result, "error"), "unknown_state");
  });

  it("announces a successful connect and drops the previous account's profile", async () => {
    const { result, calls, published, logged } = await dispatch({ kind: "oauthCallback", code: "auth-code", state: STATE });
    // The cache must be cleared even though the tokens were just written —
    // a reconnect may be a different Spotify account.
    assert.ok(calls.findIndex((call) => call[0] === "clearProfileCache") > calls.findIndex((call) => call[0] === "writeTokens"));
    assert.deepEqual(published, [["connected", { scopes: FRESH_TOKENS.scopes }]]);
    assert.deepEqual(logged, [["info", "tokens written", { scopes: FRESH_TOKENS.scopes }]]);
    assert.equal(field(result, "ok"), true);
    assert.equal(field(result, "message"), "Spotify を接続しました。");
  });

  it("keeps no tokens when the exchange fails", async () => {
    const { result, calls, logged } = await dispatch({ kind: "oauthCallback", code: "auth-code", state: STATE }, ({ spyThrows }) => ({
      exchangeCodeForTokens: spyThrows("exchangeCodeForTokens", new Error("invalid_grant")),
    }));
    assert.equal(
      calls.some((call) => call[0] === "writeTokens"),
      false,
    );
    assert.deepEqual(logged, [["error", "token exchange failed", { error: "invalid_grant" }]]);
    assert.equal(field(result, "error"), "token_exchange_failed");
    assert.equal(field(result, "message"), "invalid_grant");
  });
});

describe("status", () => {
  it("reports the account's tier and name when connected", async () => {
    const { result } = await dispatch({ kind: "status" });
    assert.deepEqual(result, {
      ok: true,
      message: "Connected.",
      data: {
        clientIdConfigured: true,
        connected: true,
        expiresAt: TOKENS.expiresAt,
        scopes: TOKENS.scopes,
        isPremium: true,
        displayName: "Ada",
      },
    });
  });

  it("leaves the tier unknown when there is nothing to authenticate with", async () => {
    const { result, calls } = await dispatch({ kind: "status" }, ({ spy }) => ({ readTokens: spy("readTokens", null) }));
    assert.equal(
      calls.some((call) => call[0] === "getProfile"),
      false,
    );
    assert.deepEqual(result, {
      ok: true,
      message: "Client ID is configured but you haven't connected yet.",
      data: { clientIdConfigured: true, connected: false, expiresAt: null, scopes: [], isPremium: null, displayName: "" },
    });
  });
});

describe("configure", () => {
  it("stores the trimmed Client ID", async () => {
    const { result } = await dispatch({ kind: "configure", clientId: " client-999 " });
    assert.deepEqual(result, { ok: true, message: "Spotify Client ID を保存しました。" });
  });

  it("refuses a whitespace-only Client ID without writing it", async () => {
    const { result, calls } = await dispatch({ kind: "configure", clientId: "   " });
    assert.deepEqual(calls, []);
    assert.equal(field(result, "error"), "invalid_client_id");
  });
});

describe("listening limits", () => {
  it("passes an explicit limit through instead of the default", async () => {
    // The routing table only covers the omitted case, which a handler that
    // ignored the argument entirely would also satisfy.
    const { calls } = await dispatch({ kind: "liked", limit: 7 });
    assert.deepEqual(
      calls.find((call) => call[0] === "fetchLiked"),
      ["fetchLiked", CREDENTIALS, 7],
    );
  });

  it("passes an explicit playlistTracks limit through", async () => {
    const { calls } = await dispatch({ kind: "playlistTracks", playlistId: "pl-1", limit: 3 });
    assert.deepEqual(
      calls.find((call) => call[0] === "fetchPlaylistTracks"),
      ["fetchPlaylistTracks", CREDENTIALS, "pl-1", 3],
    );
  });
});
