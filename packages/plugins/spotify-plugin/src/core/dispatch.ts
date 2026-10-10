// Server-side router for the `manageSpotify` tool. Every Spotify call and
// every config-dir read arrives through `context.api`, with the PluginRuntime
// half bound at the composition root (`index.ts`) — so "which kind calls what,
// with which arguments" can be checked with a stub instead of a live runtime
// (#2583). Same shape as `google-plugin` / `html-plugin`'s core/dispatch.
import type { PluginRuntime } from "gui-chat-protocol";

import { isPremium } from "../profile";
import { SPOTIFY_SCOPES } from "../oauth";
import type * as listeningModule from "../listening";
import type * as oauthModule from "../oauth";
import type * as playbackModule from "../playback";
import type * as profileModule from "../profile";
import type * as searchModule from "../search";
import type * as tokensModule from "../tokens";
import type { DispatchArgs } from "../schemas";
import { summariseSearch } from "../searchSummary";
import type { SpotifyClientConfig, SpotifyTokens } from "../types";
import {
  CLIENT_ID_MISSING_INSTRUCTIONS,
  clientIdMissing,
  mapClientError,
  mapPlayerError,
  PREMIUM_REQUIRED_RESPONSE,
  renderCallbackHtml,
  summariseListening,
  summarisePlayerResult,
  type ListeningKind,
  type PlayerKind,
} from "./responses";

/** Which account an authenticated call is for. The `runtime` half of
 *  `SpotifyDeps` is bound in `index.ts`, so neither the router nor its tests
 *  ever hold a PluginRuntime. */
export interface SpotifyCredentials {
  clientId: string;
  tokens: SpotifyTokens;
}

/** Drops the leading host argument — the `SpotifyDeps` carrying the runtime,
 *  or the plugin's `FileOps`. Parameters and return type are borrowed from the
 *  real implementation, so changing one there breaks the binding in `index.ts`
 *  instead of drifting past a hand-copied signature. */
type WithoutHostArg<F> = F extends (hostArg: infer HostArg, ...rest: infer Rest) => infer Result ? (...rest: Rest) => Result : never;

/** Same, except the router still says which account the call is for. */
type Authenticated<F> = F extends (deps: infer Deps, ...rest: infer Rest) => infer Result ? (credentials: SpotifyCredentials, ...rest: Rest) => Result : never;

export interface SpotifyApi {
  readClientConfig: WithoutHostArg<typeof tokensModule.readClientConfig>;
  writeClientConfig: WithoutHostArg<typeof tokensModule.writeClientConfig>;
  readTokens: WithoutHostArg<typeof tokensModule.readTokens>;
  writeTokens: WithoutHostArg<typeof tokensModule.writeTokens>;
  clearProfileCache: WithoutHostArg<typeof profileModule.clearProfileCache>;

  /** PKCE token exchange. Bound in `index.ts` because it is the one call that
   *  reaches Spotify through the host's `fetch` rather than the plugin's own
   *  client. */
  exchangeCodeForTokens(params: { code: string; clientId: string; codeVerifier: string; redirectUri: string }): Promise<SpotifyTokens>;

  generateRandomToken: typeof oauthModule.generateRandomToken;
  deriveCodeChallenge: typeof oauthModule.deriveCodeChallenge;
  registerPendingAuthorization: typeof oauthModule.registerPendingAuthorization;
  consumePendingAuthorization: typeof oauthModule.consumePendingAuthorization;
  buildAuthorizeUrl: typeof oauthModule.buildAuthorizeUrl;

  getProfile: Authenticated<typeof profileModule.getProfile>;
  fetchLiked: Authenticated<typeof listeningModule.fetchLiked>;
  fetchPlaylists: Authenticated<typeof listeningModule.fetchPlaylists>;
  fetchPlaylistTracks: Authenticated<typeof listeningModule.fetchPlaylistTracks>;
  fetchRecent: Authenticated<typeof listeningModule.fetchRecent>;
  fetchNowPlaying: Authenticated<typeof listeningModule.fetchNowPlaying>;
  searchSpotify: Authenticated<typeof searchModule.searchSpotify>;
  playerPlay: Authenticated<typeof playbackModule.playerPlay>;
  playerPause: Authenticated<typeof playbackModule.playerPause>;
  playerNext: Authenticated<typeof playbackModule.playerNext>;
  playerPrevious: Authenticated<typeof playbackModule.playerPrevious>;
  playerSeek: Authenticated<typeof playbackModule.playerSeek>;
  playerSetVolume: Authenticated<typeof playbackModule.playerSetVolume>;
  playerTransfer: Authenticated<typeof playbackModule.playerTransfer>;
  playerGetDevices: Authenticated<typeof playbackModule.playerGetDevices>;
}

export interface SpotifyDispatchContext {
  api: SpotifyApi;
  /** Narrowed to what the router actually writes, so a test stub stays small. */
  log: Pick<PluginRuntime["log"], "info" | "error">;
  pubsub: Pick<PluginRuntime["pubsub"], "publish">;
}

type ArgsOf<K extends DispatchArgs["kind"]> = Extract<DispatchArgs, { kind: K }>;

/** Spotify's per-request caps for these endpoints — asking for more is a 400,
 *  so the default is the maximum rather than a taste call. */
const DEFAULT_TRACK_LIMIT = 50;
const DEFAULT_PLAYLIST_TRACK_LIMIT = 100;

type CredentialsResult =
  { ok: true; credentials: SpotifyCredentials } | { ok: false; errorResponse: { ok: false; error: string; message: string; instructions?: string } };

async function loadCredentials(api: SpotifyApi): Promise<CredentialsResult> {
  const clientConfig = await api.readClientConfig();
  if (!clientConfig) {
    return { ok: false, errorResponse: clientIdMissing("Spotify Client ID が未設定です。") };
  }
  const tokens = await api.readTokens();
  if (!tokens) {
    return {
      ok: false,
      errorResponse: {
        ok: false,
        error: "not_connected",
        message: "Spotify に未接続です。「Connect」を実行してください。",
      },
    };
  }
  return { ok: true, credentials: { clientId: clientConfig.clientId, tokens } };
}

// One handler per kind (or per kind family, where the top-level switch already
// grouped them), named after the kind, so the router below reads as the
// kind → call table it is.

const connect = async ({ api }: SpotifyDispatchContext, args: ArgsOf<"connect">) => {
  const clientConfig = await api.readClientConfig();
  if (!clientConfig) return clientIdMissing("Spotify Client ID が未設定です。詳細は instructions を参照してください。");
  const codeVerifier = api.generateRandomToken();
  const codeChallenge = await api.deriveCodeChallenge(codeVerifier);
  const state = api.registerPendingAuthorization(codeVerifier, args.redirectUri);
  const authorizeUrl = api.buildAuthorizeUrl({
    clientId: clientConfig.clientId,
    redirectUri: args.redirectUri,
    scopes: SPOTIFY_SCOPES,
    state,
    codeChallenge,
  });
  return { ok: true, message: "Spotify の同意画面の URL を生成しました。ブラウザで開いてください。", data: { authorizeUrl } };
};

const completeAuthorization = async (
  { api, log, pubsub }: SpotifyDispatchContext,
  params: { code: string; clientId: string; codeVerifier: string; redirectUri: string },
) => {
  try {
    const tokens = await api.exchangeCodeForTokens(params);
    await api.writeTokens(tokens);
    // Invalidate the profile cache: a fresh Connect may be a
    // different Spotify account, so the previous user's `product`
    // must not leak through the 24h TTL (Codex review on PR
    // #1171). The next `getProfile` call will fetch the new
    // user's snapshot.
    await api.clearProfileCache();
    pubsub.publish("connected", { scopes: tokens.scopes });
    log.info("tokens written", { scopes: tokens.scopes });
    return {
      ok: true,
      message: "Spotify を接続しました。",
      html: renderCallbackHtml({ title: "Spotify connected", body: "You can close this window and return to mulmoclaude." }),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error("token exchange failed", { error: detail });
    const instructions = `Token exchange failed: ${detail}\n\nThis usually means the Redirect URI registered in your Spotify Developer Dashboard does not match the URL mulmoclaude is using:\n${params.redirectUri}`;
    return {
      ok: false,
      error: "token_exchange_failed",
      message: detail,
      instructions,
      html: renderCallbackHtml({ title: "Token exchange failed", body: instructions }),
    };
  }
};

const oauthCallback = async (context: SpotifyDispatchContext, args: ArgsOf<"oauthCallback">) => {
  const { api, log } = context;
  if (args.error) {
    log.info("user denied authorization", { error: args.error });
    return {
      ok: false,
      error: "auth_denied",
      message: `Spotify からの認可が拒否されました: ${args.error}`,
      html: renderCallbackHtml({ title: "Spotify authorization denied", body: `Spotify returned: ${args.error}` }),
    };
  }
  if (!args.code || !args.state) {
    return {
      ok: false,
      error: "invalid_callback",
      message: "Callback request was missing `code` or `state`.",
      html: renderCallbackHtml({ title: "Invalid callback", body: "Missing `code` or `state` query parameter." }),
    };
  }
  const pending = api.consumePendingAuthorization(args.state);
  if (!pending) {
    return {
      ok: false,
      error: "unknown_state",
      message: "この認可リクエストは mulmoclaude から開始されたものではない、または期限切れです。",
      instructions: "plugin View の「Connect」を再度押してください。",
      html: renderCallbackHtml({
        title: "Unknown state",
        body: "This authorization request was not initiated by mulmoclaude (or it expired). Please retry from the plugin View.",
      }),
    };
  }
  const clientConfig = await api.readClientConfig();
  if (!clientConfig) {
    return clientIdMissing(
      "Spotify Client ID が未設定です。",
      renderCallbackHtml({ title: "Spotify client ID not configured", body: CLIENT_ID_MISSING_INSTRUCTIONS }),
    );
  }
  return await completeAuthorization(context, {
    code: args.code,
    clientId: clientConfig.clientId,
    codeVerifier: pending.codeVerifier,
    redirectUri: pending.redirectUri,
  });
};

const status = async ({ api }: SpotifyDispatchContext) => {
  const clientConfig = await api.readClientConfig();
  const tokens = await api.readTokens();
  // Only call /v1/me when we have tokens — otherwise there's
  // nothing to authenticate with. Cache hit is the common case
  // (24h TTL) so most `status` calls don't go to Spotify.
  const profileResult = tokens && clientConfig ? await api.getProfile({ clientId: clientConfig.clientId, tokens }) : null;
  const profile = profileResult && profileResult.ok ? profileResult.profile : null;
  return {
    ok: true,
    message: tokens ? "Connected." : clientConfig ? "Client ID is configured but you haven't connected yet." : "Client ID is not configured.",
    data: {
      clientIdConfigured: clientConfig !== null,
      connected: tokens !== null,
      expiresAt: tokens?.expiresAt ?? null,
      scopes: tokens?.scopes ?? [],
      // PR 3 — null when we couldn't determine (no tokens, or
      // /v1/me failed). View renders the player gate accordingly.
      isPremium: profile ? isPremium(profile) : null,
      displayName: profile?.displayName ?? "",
    },
  };
};

const diagnose = async ({ api }: SpotifyDispatchContext) => {
  const clientConfig = await api.readClientConfig();
  const tokens = await api.readTokens();
  return {
    ok: true,
    message: "See `data` for the connection diagnostics.",
    data: {
      clientIdConfigured: clientConfig !== null,
      tokensPresent: tokens !== null,
      expiresAt: tokens?.expiresAt ?? null,
      scopes: tokens?.scopes ?? [],
      // Never return the actual token / client_id values — diagnose
      // is meant for the LLM to read aloud.
    },
  };
};

const configure = async ({ api, log }: SpotifyDispatchContext, args: ArgsOf<"configure">) => {
  const trimmed = args.clientId.trim();
  // Schema guarantees `min(1)` on the input, but trimming can
  // collapse whitespace-only strings to length 0 (CodeRabbit
  // review on PR #1166). Reject so we never persist a useless
  // Client ID that would silently break OAuth on the next
  // `connect` attempt.
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: "invalid_client_id",
      message: "Client ID が空です。Spotify Developer Dashboard からコピーした文字列を貼り付けてください。",
    };
  }
  const config: SpotifyClientConfig = { clientId: trimmed };
  await api.writeClientConfig(config);
  log.info("client id configured");
  return { ok: true, message: "Spotify Client ID を保存しました。" };
};

async function invokeListening(api: SpotifyApi, credentials: SpotifyCredentials, args: ArgsOf<ListeningKind>) {
  switch (args.kind) {
    case "liked":
      return await api.fetchLiked(credentials, args.limit ?? DEFAULT_TRACK_LIMIT);
    case "playlists":
      return await api.fetchPlaylists(credentials);
    case "playlistTracks":
      return await api.fetchPlaylistTracks(credentials, args.playlistId, args.limit ?? DEFAULT_PLAYLIST_TRACK_LIMIT);
    case "recent":
      return await api.fetchRecent(credentials, args.limit ?? DEFAULT_TRACK_LIMIT);
    case "nowPlaying":
      return await api.fetchNowPlaying(credentials);
    default: {
      const exhaustive: never = args;
      throw new Error(`Unhandled listening kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

const listeningKinds = async ({ api }: SpotifyDispatchContext, args: ArgsOf<ListeningKind>) => {
  const ready = await loadCredentials(api);
  if (!ready.ok) return ready.errorResponse;
  const result = await invokeListening(api, ready.credentials, args);
  if (!result.ok) return mapClientError(result.error);
  // The host MCP bridge passes ONLY `message` + `instructions` back
  // to the LLM (`data` is rendered in the View). For read kinds the
  // LLM needs the actual list of tracks / playlists to reason
  // about, so we mirror the listing into `message` as a compact
  // text format. Format mirrors what a human would write on a chat
  // thread; not designed for machine round-tripping (the View has
  // the structured `data`).
  return { ok: true, message: summariseListening(args.kind, result.data), data: result.data };
};

const search = async ({ api }: SpotifyDispatchContext, args: ArgsOf<"search">) => {
  const ready = await loadCredentials(api);
  if (!ready.ok) return ready.errorResponse;
  const result = await api.searchSpotify(ready.credentials, args.query, args.types, args.limit);
  if (!result.ok) return mapClientError(result.error);
  return { ok: true, message: summariseSearch(args.query, result.data), data: result.data };
};

async function invokePlayer(api: SpotifyApi, credentials: SpotifyCredentials, args: ArgsOf<PlayerKind>) {
  switch (args.kind) {
    case "play":
      return await api.playerPlay(credentials, { deviceId: args.deviceId, contextUri: args.contextUri, trackUris: args.trackUris });
    case "pause":
      return await api.playerPause(credentials, args.deviceId);
    case "next":
      return await api.playerNext(credentials, args.deviceId);
    case "previous":
      return await api.playerPrevious(credentials, args.deviceId);
    case "seek":
      return await api.playerSeek(credentials, args.positionMs, args.deviceId);
    case "setVolume":
      return await api.playerSetVolume(credentials, args.volumePercent, args.deviceId);
    case "transferPlayback":
      return await api.playerTransfer(credentials, args.deviceId, args.play);
    case "getDevices":
      return await api.playerGetDevices(credentials);
    default: {
      const exhaustive: never = args;
      throw new Error(`Unhandled player kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Premium is required for everything except `getDevices`. Refuse up front only when Spotify
 *  said the account is not Premium; an unknown tier goes through, and the Player API's own 403
 *  maps to the same response in `mapPlayerError`. */
async function premiumGate(api: SpotifyApi, credentials: SpotifyCredentials) {
  const profileResult = await api.getProfile(credentials);
  if (!profileResult.ok) return mapClientError(profileResult.error);
  return isPremium(profileResult.profile) === false ? PREMIUM_REQUIRED_RESPONSE : null;
}

const playerKinds = async ({ api }: SpotifyDispatchContext, args: ArgsOf<PlayerKind>) => {
  // Spotify's `/v1/me/player/play` 400s if a body carries both
  // `context_uri` and `uris[]`. Catching this here (since we
  // can't .refine() inside a discriminatedUnion arm) gives a
  // clean error instead of a confusing 4xx from Spotify.
  if (args.kind === "play" && args.contextUri && args.trackUris) {
    return {
      ok: false,
      error: "invalid_args",
      message: "play: `contextUri` と `trackUris` は同時に指定できません。どちらか一方を選んでください。",
    };
  }
  const ready = await loadCredentials(api);
  if (!ready.ok) return ready.errorResponse;
  if (args.kind !== "getDevices") {
    const gate = await premiumGate(api, ready.credentials);
    if (gate) return gate;
  }
  const result = await invokePlayer(api, ready.credentials, args);
  if (!result.ok) return mapPlayerError(result.error, args.kind);
  return summarisePlayerResult(args.kind, result.data);
};

export async function executeSpotifyDispatch(context: SpotifyDispatchContext, args: DispatchArgs): Promise<unknown> {
  switch (args.kind) {
    case "connect":
      return await connect(context, args);
    case "oauthCallback":
      return await oauthCallback(context, args);
    case "status":
      return await status(context);
    case "diagnose":
      return await diagnose(context);
    case "configure":
      return await configure(context, args);
    case "liked":
    case "playlists":
    case "playlistTracks":
    case "recent":
    case "nowPlaying":
      return await listeningKinds(context, args);
    case "search":
      return await search(context, args);
    case "play":
    case "pause":
    case "next":
    case "previous":
    case "seek":
    case "setVolume":
    case "transferPlayback":
    case "getDevices":
      return await playerKinds(context, args);
    default: {
      // Exhaustiveness guard: a new kind without a branch trips this at compile time.
      const exhaustive: never = args;
      throw new Error(`Unhandled kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
