// Every LLM- and View-facing string the dispatch produces. Pure — no runtime,
// no I/O — so the router next door stays a router and the formatting can be
// exercised directly.
import { escapeHtml } from "@mulmoclaude/common";

import type { SpotifyClientError } from "../client";
import { withTrackUri, withUri } from "../spotifyUri";
import type { NormalisedDevice } from "../types";

export type PlayerKind = "play" | "pause" | "next" | "previous" | "seek" | "setVolume" | "transferPlayback" | "getDevices";
export type ListeningKind = "liked" | "playlists" | "playlistTracks" | "recent" | "nowPlaying";

export const CLIENT_ID_MISSING_INSTRUCTIONS = [
  "Spotify の Client ID が未設定です。",
  "",
  "1. https://developer.spotify.com/dashboard を開いて Spotify アカウントでログイン",
  "2. 「Create app」 → Redirect URIs に http://127.0.0.1:<PORT>/api/plugins/runtime/oauth-callback/spotify を追加 (PORT は mulmoclaude が動いているポート)",
  "3. Web API をチェックして保存",
  "4. Client ID をコピー",
  "5. plugin View の「Configure」で貼り付ける",
  "",
  "詳細: docs/tips/spotify-setup.md",
].join("\n");

/** The three places that answer "no Client ID yet" word the message
 *  differently — the OAuth callback also carries a rendered page — but all of
 *  them hand back the same setup walkthrough. */
export const clientIdMissing = (message: string, html?: string) => ({
  ok: false as const,
  error: "client_id_missing",
  message,
  instructions: CLIENT_ID_MISSING_INSTRUCTIONS,
  ...(html === undefined ? {} : { html }),
});

/** Build the LLM-facing message string for a listening result.
 *  The plain text mirrors the View's grid: title + artists, one per
 *  line. Length-capped per kind so the LLM context window doesn't
 *  blow up on a 50-track Liked Songs response. */
export function summariseListening(kind: ListeningKind, data: unknown): string {
  if (kind === "nowPlaying") {
    if (!data || typeof data !== "object" || !("name" in data)) return "Nothing is currently playing.";
    const track = data as { name: string; artists: string[]; album: string; trackUri?: string };
    return withTrackUri(`Now playing: ${track.name} — ${track.artists.join(", ")} (${track.album})`, track);
  }
  if (!Array.isArray(data) || data.length === 0) return `No ${kind} items.`;
  if (kind === "playlists") {
    const lines = (data as { id: string; name: string; trackCount: number }[]).map((p, i) =>
      withUri(`${i + 1}. ${p.name} (${p.trackCount} tracks)`, "playlist", p.id),
    );
    return `Playlists (${data.length}):\n${lines.join("\n")}`;
  }
  if (kind === "recent") {
    const lines = (data as { track: { name: string; artists: string[]; trackUri?: string }; playedAt: string }[]).map((item, i) => {
      const when = item.playedAt ? new Date(item.playedAt).toISOString().slice(0, 16).replace("T", " ") : "?";
      return withTrackUri(`${i + 1}. [${when}] ${item.track.name} — ${item.track.artists.join(", ")}`, item.track);
    });
    return `Recently played (${data.length}):\n${lines.join("\n")}`;
  }
  // liked / playlistTracks share the NormalisedTrack[] shape.
  const lines = (data as { name: string; artists: string[]; trackUri?: string }[]).map((t, i) =>
    withTrackUri(`${i + 1}. ${t.name} — ${t.artists.join(", ")}`, t),
  );
  const title = kind === "liked" ? "Liked Songs" : "Playlist tracks";
  return `${title} (${data.length}):\n${lines.join("\n")}`;
}

const PLAYER_SUCCESS_MESSAGES: Record<Exclude<PlayerKind, "getDevices">, string> = {
  play: "再生を開始しました。",
  pause: "再生を一時停止しました。",
  next: "次の曲に進みました。",
  previous: "前の曲に戻りました。",
  seek: "位置をシークしました。",
  setVolume: "音量を変更しました。",
  transferPlayback: "再生をデバイスに移しました。",
};

export function summarisePlayerResult(kind: PlayerKind, data: NormalisedDevice[] | null) {
  if (kind === "getDevices") {
    const devices = data ?? [];
    if (devices.length === 0) {
      return {
        ok: true,
        message: "アクティブな Spotify デバイスがありません。Spotify アプリを起動してから再度お試しください。",
        data: devices,
      };
    }
    const lines = devices.map((d, i) => `${i + 1}. ${d.name} (${d.type})${d.isActive ? " — active" : ""}`);
    return { ok: true, message: `Devices (${devices.length}):\n${lines.join("\n")}`, data: devices };
  }
  return { ok: true, message: PLAYER_SUCCESS_MESSAGES[kind] };
}

export const PREMIUM_REQUIRED_RESPONSE = {
  ok: false,
  error: "premium_required",
  message: "Spotify Premium が必要な操作です。Free アカウントでは再生制御は使えません。",
  instructions: "Spotify Premium にアップグレードしてください。再生制御以外 (Liked / Playlists / Recent / Search) は Free でも引き続き利用できます。",
} as const;

export function mapPlayerError(error: SpotifyClientError, kind: PlayerKind) {
  // Spotify returns 404 for "no active device" on most player
  // endpoints. Surface a user-friendly hint that points at the
  // device dropdown instead of the generic API-error message.
  if (error.kind === "spotify_api_error" && error.status === 404 && kind !== "getDevices") {
    return {
      ok: false,
      error: "no_active_device",
      message: "アクティブな Spotify デバイスがありません。Spotify アプリ (デスクトップ / モバイル / Web) を起動してから再度お試しください。",
      instructions: "View の Player タブから対象デバイスを選んで「Transfer」を押すか、Spotify アプリ側で何か再生してから再試行してください。",
    };
  }
  if (error.kind === "spotify_api_error" && error.status === 403 && error.body.includes("PREMIUM_REQUIRED")) {
    return PREMIUM_REQUIRED_RESPONSE;
  }
  if (error.kind === "spotify_api_error" && error.status === 403 && error.body.includes("scope")) {
    return {
      ok: false,
      error: "scope_missing",
      message: "新しい権限の追加が必要です。Spotify View ヘッダの「Reconnect」ボタンを押して再認可してください。",
      instructions:
        "PR 3 で追加された Player 制御は新しい OAuth scope を要求します。View 右上の「Reconnect」ボタンで Spotify の同意画面を開き直すと scope が更新されます。",
    };
  }
  return mapClientError(error);
}

export function mapClientError(error: SpotifyClientError) {
  switch (error.kind) {
    case "auth_expired":
      return {
        ok: false as const,
        error: "auth_expired",
        message: "認可が無効化されました。「Connect」をやり直してください。",
        detail: error.detail,
      };
    case "transient_error":
      return {
        ok: false as const,
        error: "transient_error",
        message: "Spotify に一時的に接続できませんでした。しばらくしてから再試行してください。",
        detail: error.detail,
      };
    case "rate_limited":
      return {
        ok: false as const,
        error: "rate_limited",
        message: `Spotify から rate limit を返されました。${error.retryAfterSec} 秒後に再試行してください。`,
        retryAfterSec: error.retryAfterSec,
      };
    case "spotify_api_error":
      return {
        ok: false as const,
        error: "spotify_api_error",
        message: `Spotify API がエラーを返しました (${error.status})`,
        detail: error.body,
      };
    case "not_connected":
      return { ok: false as const, error: "not_connected", message: "Spotify に未接続です。" };
  }
}

export function renderCallbackHtml(params: { title: string; body: string }): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(params.title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#111}h1{margin-bottom:1rem}pre{white-space:pre-wrap;background:#f5f5f5;padding:1rem;border-radius:.5rem}</style>
<h1>${escapeHtml(params.title)}</h1>
<pre>${escapeHtml(params.body)}</pre>
</html>`;
}
