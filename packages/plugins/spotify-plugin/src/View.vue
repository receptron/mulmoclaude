<script setup lang="ts">
// Spotify plugin View. Shows connection state in the header and the
// listening data (liked / playlists / recent / now playing) below.
//
// State machine:
//   - status === null      → loading (initial render)
//   - clientIdConfigured === false → show Configure form
//   - clientIdConfigured === true && connected === false → show Connect button
//   - connected === true   → show tabs + the active tab's data
//
// Each tab fetches lazily on first activation; refreshes on the
// "connected" pubsub event so a freshly authorised user sees data
// immediately without manually clicking Refresh.

import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRuntime } from "gui-chat-protocol/vue";
import { useT } from "./lang";
import type { NormalisedDevice, NormalisedPlaylist, NormalisedTrack, RecentlyPlayedItem, SearchResult } from "./types";
import {
  AckResponseSchema,
  ConnectResponseSchema,
  DevicesResponseSchema,
  LikedResponseSchema,
  NowPlayingResponseSchema,
  PlaylistsResponseSchema,
  RecentResponseSchema,
  SearchResponseSchema,
  StatusResponseSchema,
  type StatusData,
  type WireDevice,
  type WirePlaylist,
  type WireRecentItem,
  type WireSearchResult,
  type WireTrack,
} from "./schemas";

type Tab = "liked" | "playlists" | "recent" | "nowPlaying" | "search";

const { dispatch, openUrl, pubsub, log } = useRuntime();
const t = useT();

const status = ref<StatusData | null>(null);
const activeTab = ref<Tab>("liked");
const liked = ref<WireTrack[] | null>(null);
const playlists = ref<WirePlaylist[] | null>(null);
const recent = ref<WireRecentItem[] | null>(null);
const nowPlaying = ref<WireTrack | null | undefined>(undefined);
const searchQuery = ref("");
const searchResult = ref<WireSearchResult | null>(null);
const isSearching = ref(false);
const tabError = ref<string | null>(null);
const isLoadingTab = ref(false);

const clientIdInput = ref("");
const isSavingClientId = ref(false);
const saveError = ref<string | null>(null);

const isConnecting = ref(false);

// Player Controls (PR 3)
const devices = ref<WireDevice[]>([]);
const playerError = ref<string | null>(null);
const isPlayerBusy = ref(false);
const volumeInput = ref(50);

async function refreshStatus(): Promise<void> {
  try {
    const response = await dispatch({ kind: "status" }, (raw) => StatusResponseSchema.parse(raw));
    if (response.ok) status.value = response.data;
  } catch (err) {
    log.warn("status fetch failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

async function saveClientId(): Promise<void> {
  if (clientIdInput.value.trim().length === 0) return;
  isSavingClientId.value = true;
  saveError.value = null;
  try {
    await dispatch({ kind: "configure", clientId: clientIdInput.value.trim() });
    clientIdInput.value = "";
    await refreshStatus();
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  } finally {
    isSavingClientId.value = false;
  }
}

// Spotify's redirect-URI policy:
//   1. `localhost` is rejected — must use `127.0.0.1` or `[::1]`
//   2. URI must match the one registered in the Dashboard EXACTLY
//
// We honour the actual page origin so that:
//   - Custom port via `--port 3099` → redirectUri uses 3099 (user
//     registers `127.0.0.1:3099/api/...` in their Dashboard).
//   - Vite dev (`5173`) → redirectUri uses 5173 (Vite proxy
//     forwards `/api/*` to the server).
//   - Production (server serves the SPA on 3001) → matches.
//
// `localhost` is coerced to `127.0.0.1` because Spotify rejects
// `localhost` outright — the proxy / browser still hits the same
// loopback address either way.
function computeRedirectUri(): string {
  const origin = window.location.origin.replace("//localhost:", "//127.0.0.1:").replace("//localhost/", "//127.0.0.1/");
  return `${origin}/api/plugins/runtime/oauth-callback/spotify`;
}

async function startConnect(): Promise<void> {
  isConnecting.value = true;
  try {
    const response = await dispatch({ kind: "connect", redirectUri: computeRedirectUri() }, (raw) => ConnectResponseSchema.parse(raw));
    if (response.ok && response.data?.authorizeUrl) {
      // Open the consent screen in a new tab. The original tab
      // keeps the View; the server's `connected` pubsub event
      // (fired after the OAuth callback) refreshes status here so
      // the user sees Premium controls populate without manually
      // reloading. `noopener,noreferrer` for the standard
      // tab-isolation hygiene; the new tab navigates within
      // accounts.spotify.com → 127.0.0.1:3001 which is fine.
      window.open(response.data.authorizeUrl, "_blank", "noopener,noreferrer");
    } else {
      log.warn("connect failed", { response });
    }
  } catch (err) {
    log.warn("connect dispatch threw", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    isConnecting.value = false;
  }
}

async function loadLiked(): Promise<void> {
  const response = await dispatch({ kind: "liked" }, (raw) => LikedResponseSchema.parse(raw));
  if (response.ok && response.data) liked.value = response.data;
  else tabError.value = response.message ?? t.value.loadFailed;
}

async function loadPlaylists(): Promise<void> {
  const response = await dispatch({ kind: "playlists" }, (raw) => PlaylistsResponseSchema.parse(raw));
  if (response.ok && response.data) playlists.value = response.data;
  else tabError.value = response.message ?? t.value.loadFailed;
}

async function loadRecent(): Promise<void> {
  const response = await dispatch({ kind: "recent" }, (raw) => RecentResponseSchema.parse(raw));
  if (response.ok && response.data) recent.value = response.data;
  else tabError.value = response.message ?? t.value.loadFailed;
}

async function loadNowPlaying(): Promise<void> {
  const response = await dispatch({ kind: "nowPlaying" }, (raw) => NowPlayingResponseSchema.parse(raw));
  if (response.ok) nowPlaying.value = response.data ?? null;
  else tabError.value = response.message ?? t.value.loadFailed;
  // Always also (re)load devices so the dropdown stays current —
  // free users see the list (no controls) and premium users see
  // controls + dropdown together.
  void loadDevices();
}

async function loadSearch(): Promise<void> {
  // Search has no auto-fetch on tab activation — there's nothing
  // to search for until the user types a query. But when this is
  // reached via `refreshActiveTab()` (Refresh / Retry buttons), we
  // DO want to re-run the last query if there was one. Otherwise
  // a transient API error on the previous search is unrecoverable
  // (Codex review on PR #1168).
  if (searchQuery.value.trim().length > 0) {
    await runSearch();
  }
}

async function runSearch(): Promise<void> {
  const query = searchQuery.value.trim();
  if (query.length === 0) return;
  isSearching.value = true;
  tabError.value = null;
  try {
    const response = await dispatch({ kind: "search", query }, (raw) => SearchResponseSchema.parse(raw));
    if (response.ok && response.data) searchResult.value = response.data;
    else tabError.value = response.message ?? t.value.loadFailed;
  } catch (err) {
    tabError.value = err instanceof Error ? err.message : String(err);
  } finally {
    isSearching.value = false;
  }
}

const TAB_LOADERS: Record<Tab, () => Promise<void>> = {
  liked: loadLiked,
  playlists: loadPlaylists,
  recent: loadRecent,
  nowPlaying: loadNowPlaying,
  search: loadSearch,
};

function tabIsCached(tab: Tab): boolean {
  if (tab === "liked") return liked.value !== null;
  if (tab === "playlists") return playlists.value !== null;
  if (tab === "recent") return recent.value !== null;
  if (tab === "nowPlaying") return nowPlaying.value !== undefined;
  // Search tab is always "cached" — its content is driven by the
  // input box, not by tab activation.
  return true;
}

async function loadActiveTab(force = false): Promise<void> {
  if (!status.value?.connected) return;
  // Always clear an inherited error from a previous tab BEFORE the
  // cache-hit early-return — otherwise switching from a tab whose
  // last load failed onto a cached/never-loads tab (notably Search,
  // whose tabIsCached is always true) leaves the prior error message
  // floating over unrelated content (Codex review on PR #1168).
  tabError.value = null;
  // Cache hit on tab switch — header comment promises lazy loading,
  // so a click on a tab whose data is already loaded must NOT
  // re-dispatch (CodeRabbit + Sourcery review on PR #1166).
  // Refresh button passes force=true to bypass.
  if (!force && tabIsCached(activeTab.value)) return;
  isLoadingTab.value = true;
  try {
    await TAB_LOADERS[activeTab.value]();
  } catch (err) {
    tabError.value = err instanceof Error ? err.message : String(err);
  } finally {
    isLoadingTab.value = false;
  }
}

function selectTab(next: Tab): void {
  activeTab.value = next;
  void loadActiveTab();
}

function refreshActiveTab(): void {
  void loadActiveTab(true);
}

// Player Controls (PR 3) — Premium-gated; getDevices works for Free
// users too so the dropdown loads regardless of plan.
async function loadDevices(): Promise<void> {
  try {
    const response = await dispatch({ kind: "getDevices" }, (raw) => DevicesResponseSchema.parse(raw));
    if (response.ok && response.data) devices.value = response.data;
  } catch (err) {
    log.warn("getDevices failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

async function dispatchPlayer(args: object, busyMessage: string): Promise<void> {
  isPlayerBusy.value = true;
  playerError.value = null;
  try {
    const response = await dispatch(args, (raw) => AckResponseSchema.parse(raw));
    if (!response.ok) {
      playerError.value = response.message ?? busyMessage;
    } else {
      // Refresh now-playing card after a successful action so the
      // user sees the new track / pause state.
      await loadNowPlaying();
    }
  } catch (err) {
    playerError.value = err instanceof Error ? err.message : String(err);
  } finally {
    isPlayerBusy.value = false;
  }
}

function playerPlay(): void {
  void dispatchPlayer({ kind: "play" }, t.value.loadFailed);
}
function playerPause(): void {
  void dispatchPlayer({ kind: "pause" }, t.value.loadFailed);
}
function playerNext(): void {
  void dispatchPlayer({ kind: "next" }, t.value.loadFailed);
}
function playerPrevious(): void {
  void dispatchPlayer({ kind: "previous" }, t.value.loadFailed);
}
function playerVolume(): void {
  void dispatchPlayer({ kind: "setVolume", volumePercent: volumeInput.value }, t.value.loadFailed);
}
function playerTransfer(deviceId: string): void {
  void dispatchPlayer({ kind: "transferPlayback", deviceId, play: false }, t.value.loadFailed).then(() => loadDevices());
}

// `NormalisedTrack.url` is optional (locally-uploaded tracks and
// podcast episodes carry no `external_urls.spotify`). Guard the
// click so we don't `openUrl(undefined)` and end up navigating to
// "undefined" or to a sentinel empty string.
function safeOpenUrl(url: string | undefined): void {
  if (typeof url === "string" && url.length > 0) openUrl(url);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// Spotify can return all four categories as empty arrays for a query
// that has no hits in any of them. Without an explicit empty-state
// the View renders a blank box (Codex review on PR #1168).
const searchResultIsEmpty = computed(() => {
  const result = searchResult.value;
  if (!result) return false;
  return !(result.tracks?.length || result.artists?.length || result.albums?.length || result.playlists?.length);
});

const expiryDisplay = computed(() => {
  if (!status.value?.expiresAt) return "";
  try {
    return new Date(status.value.expiresAt).toLocaleString();
  } catch {
    return status.value.expiresAt;
  }
});

const unsubs: Array<() => void> = [];
onMounted(() => {
  unsubs.push(
    pubsub.subscribe("connected", () => {
      // OAuth completion → refresh status, then refetch the active
      // tab (force=true bypasses the cache so we don't show stale
      // data after a reconnect with new scopes).
      void refreshStatus().then(() => loadActiveTab(true));
    }),
  );
  void refreshStatus().then(() => loadActiveTab());
});
onUnmounted(() => {
  for (const unsub of unsubs) unsub();
});
</script>

<template>
  <div class="spotify-view">
    <header class="spotify-header">
      <h2>{{ t.title }}</h2>
      <div class="spotify-status">
        <template v-if="status === null">{{ t.loading }}</template>
        <template v-else-if="!status.clientIdConfigured">{{ t.notConfigured }}</template>
        <template v-else-if="!status.connected">{{ t.notConnected }}</template>
        <template v-else>
          <span class="spotify-connected-pill">{{ t.connected }}</span>
          <span class="spotify-expiry">{{ t.expiresAt }}: {{ expiryDisplay }}</span>
          <!-- PR 3 added two OAuth scopes; existing PR 1/2 connections
               work for read-only kinds but Player Controls hit
               `403 Insufficient client scope` until reconnect. The
               Reconnect button is always available so the user can
               re-authorise without manually deleting tokens.json. -->
          <button type="button" class="spotify-reconnect" :disabled="isConnecting" @click="startConnect">
            {{ isConnecting ? t.connecting : t.reconnect }}
          </button>
        </template>
      </div>
    </header>

    <!-- Configure form (no Client ID yet) -->
    <section v-if="status && !status.clientIdConfigured" class="spotify-configure">
      <p class="spotify-configure-help">{{ t.configureHelp }}</p>
      <form class="spotify-configure-form" @submit.prevent="saveClientId">
        <input v-model="clientIdInput" :placeholder="t.configurePlaceholder" class="spotify-input" type="text" autocomplete="off" />
        <button type="submit" :disabled="isSavingClientId || clientIdInput.trim().length === 0" class="spotify-btn-primary">
          {{ isSavingClientId ? t.saving : t.save }}
        </button>
      </form>
      <p v-if="saveError" class="spotify-error">{{ saveError }}</p>
    </section>

    <!-- Connect button (Client ID set, no tokens) -->
    <section v-else-if="status && status.clientIdConfigured && !status.connected" class="spotify-connect-section">
      <button type="button" :disabled="isConnecting" class="spotify-btn-primary" @click="startConnect">
        {{ isConnecting ? t.connecting : t.connect }}
      </button>
    </section>

    <!-- Connected: tabs + content -->
    <div v-else-if="status?.connected" class="spotify-connected">
      <!-- ARIA: `role="tablist"` may only contain `role="tab"` elements,
           so the Refresh control sits outside the nav (CodeRabbit
           review on PR #1166). -->
      <div class="spotify-tab-row">
        <nav class="spotify-tabs" role="tablist">
          <button
            v-for="tab in ['liked', 'playlists', 'recent', 'nowPlaying', 'search'] as const"
            :key="tab"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab"
            :class="['spotify-tab', { 'spotify-tab-active': activeTab === tab }]"
            @click="selectTab(tab)"
          >
            {{
              tab === "liked"
                ? t.tabLiked
                : tab === "playlists"
                  ? t.tabPlaylists
                  : tab === "recent"
                    ? t.tabRecent
                    : tab === "nowPlaying"
                      ? t.tabNowPlaying
                      : t.tabSearch
            }}
          </button>
        </nav>
        <button v-if="activeTab !== 'search'" type="button" class="spotify-refresh" @click="refreshActiveTab">{{ t.refresh }}</button>
      </div>

      <div class="spotify-content">
        <p v-if="isLoadingTab" class="spotify-loading">{{ t.loading }}</p>
        <p v-else-if="tabError" class="spotify-error">
          {{ tabError }} <button class="spotify-retry" @click="refreshActiveTab">{{ t.retry }}</button>
        </p>

        <ul v-else-if="activeTab === 'liked' && liked && liked.length > 0" class="spotify-list">
          <li v-for="track in liked" :key="track.id" class="spotify-track-row">
            <button type="button" class="spotify-track-link" @click="safeOpenUrl(track.url)">
              <img v-if="track.imageUrl" :src="track.imageUrl" alt="" class="spotify-cover" />
              <span class="spotify-track-meta">
                <span class="spotify-track-name">{{ track.name }}</span>
                <span class="spotify-track-artists">{{ t.trackBy }} {{ track.artists.join(", ") }}</span>
              </span>
              <span class="spotify-track-duration">{{ formatDuration(track.durationMs) }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="activeTab === 'liked'" class="spotify-empty">{{ t.emptyLiked }}</p>

        <ul v-else-if="activeTab === 'playlists' && playlists && playlists.length > 0" class="spotify-list">
          <li v-for="playlist in playlists" :key="playlist.id" class="spotify-playlist-row">
            <button type="button" class="spotify-track-link" @click="safeOpenUrl(playlist.url)">
              <img v-if="playlist.imageUrl" :src="playlist.imageUrl" alt="" class="spotify-cover" />
              <span class="spotify-track-meta">
                <span class="spotify-track-name">{{ playlist.name }}</span>
                <span class="spotify-track-artists">{{ playlist.trackCount }} {{ t.tracksCount }}</span>
              </span>
            </button>
          </li>
        </ul>
        <p v-else-if="activeTab === 'playlists'" class="spotify-empty">{{ t.emptyPlaylists }}</p>

        <ul v-else-if="activeTab === 'recent' && recent && recent.length > 0" class="spotify-list">
          <li v-for="item in recent" :key="`${item.track.id}-${item.playedAt}`" class="spotify-track-row">
            <button type="button" class="spotify-track-link" @click="safeOpenUrl(item.track.url)">
              <img v-if="item.track.imageUrl" :src="item.track.imageUrl" alt="" class="spotify-cover" />
              <span class="spotify-track-meta">
                <span class="spotify-track-name">{{ item.track.name }}</span>
                <span class="spotify-track-artists">{{ t.trackBy }} {{ item.track.artists.join(", ") }}</span>
              </span>
            </button>
          </li>
        </ul>
        <p v-else-if="activeTab === 'recent'" class="spotify-empty">{{ t.emptyRecent }}</p>

        <template v-else-if="activeTab === 'nowPlaying'">
          <div v-if="nowPlaying" class="spotify-now-playing">
            <button type="button" class="spotify-track-link" @click="safeOpenUrl(nowPlaying.url)">
              <img v-if="nowPlaying.imageUrl" :src="nowPlaying.imageUrl" alt="" class="spotify-now-cover" />
              <span class="spotify-track-meta">
                <span class="spotify-track-name">{{ nowPlaying.name }}</span>
                <span class="spotify-track-artists">{{ t.trackBy }} {{ nowPlaying.artists.join(", ") }}</span>
                <span class="spotify-track-album">{{ nowPlaying.album }}</span>
              </span>
            </button>
          </div>
          <p v-else class="spotify-empty">{{ t.emptyNowPlaying }}</p>

          <!-- Player Controls (PR 3). Premium-gated: Free users see
               a notice instead of buttons. An unknown tier (`isPremium`
               null — `/v1/me` often omits `product`) shows the buttons and
               lets Spotify's own 403 decide. The device dropdown is
               always visible (helps the user transfer playback to
               a different device + diagnose "no active device"). -->
          <section v-if="status?.isPremium === false" class="spotify-player-locked">
            <h3>{{ t.playerControls }}</h3>
            <p>{{ t.premiumRequired }}</p>
          </section>
          <section v-else class="spotify-player">
            <h3>{{ t.playerControls }}</h3>
            <div class="spotify-player-buttons">
              <button type="button" class="spotify-player-btn" :aria-label="t.btnPrevious" :disabled="isPlayerBusy" @click="playerPrevious">⏮</button>
              <button type="button" class="spotify-player-btn" :aria-label="t.btnPause" :disabled="isPlayerBusy" @click="playerPause">⏸</button>
              <button type="button" class="spotify-player-btn" :aria-label="t.btnPlay" :disabled="isPlayerBusy" @click="playerPlay">▶</button>
              <button type="button" class="spotify-player-btn" :aria-label="t.btnNext" :disabled="isPlayerBusy" @click="playerNext">⏭</button>
            </div>
            <div class="spotify-player-volume">
              <label for="spotify-volume">{{ t.volume }}: {{ volumeInput }}</label>
              <input id="spotify-volume" v-model.number="volumeInput" type="range" min="0" max="100" :disabled="isPlayerBusy" @change="playerVolume" />
            </div>
            <p v-if="playerError" class="spotify-error">{{ playerError }}</p>
          </section>

          <section v-if="devices.length > 0" class="spotify-devices">
            <h3>{{ t.devices }}</h3>
            <ul class="spotify-list">
              <!-- Some Spotify devices ship with `id: null` (restricted
                   for DRM / account-state reasons). They're displayed
                   informationally but the Transfer button is disabled —
                   `playerTransfer` requires a usable ID. Fallback key
                   is `name` so Vue's :key stays unique-ish. -->
              <li v-for="(device, idx) in devices" :key="device.id ?? `name:${device.name}:${idx}`" class="spotify-device-row">
                <span class="spotify-device-name">{{ device.name }}</span>
                <span class="spotify-device-type">{{ device.type }}</span>
                <span v-if="device.isActive" class="spotify-device-active">{{ t.deviceActive }}</span>
                <button
                  v-else-if="status?.isPremium !== false"
                  type="button"
                  class="spotify-device-transfer"
                  :disabled="isPlayerBusy || device.id === null"
                  :aria-disabled="device.id === null"
                  @click="device.id !== null && playerTransfer(device.id)"
                >
                  {{ t.transferToDevice }}
                </button>
              </li>
            </ul>
          </section>
        </template>

        <!-- Search panel: input + grouped results. Unlike the other
             tabs, no auto-fetch on tab activation — driven by the
             user's submit. -->
        <template v-else-if="activeTab === 'search'">
          <form class="spotify-search-form" @submit.prevent="runSearch">
            <!-- A placeholder is not an accessible name (it disappears on
                 input). Pair the input with an explicit aria-label so
                 screen readers always announce the control regardless
                 of whether the user has typed anything yet (Codex
                 review on PR #1168). -->
            <input
              v-model="searchQuery"
              :placeholder="t.searchPlaceholder"
              :aria-label="t.searchPlaceholder"
              class="spotify-input"
              type="search"
              autocomplete="off"
              :disabled="isSearching"
            />
            <button type="submit" class="spotify-btn-primary" :disabled="isSearching || searchQuery.trim().length === 0">
              {{ isSearching ? t.loading : t.searchSubmit }}
            </button>
          </form>

          <div v-if="searchResult && searchResultIsEmpty" class="spotify-empty">{{ t.searchEmpty }}</div>
          <div v-else-if="searchResult" class="spotify-search-results">
            <section v-if="searchResult.tracks && searchResult.tracks.length > 0" class="spotify-search-section">
              <h3>{{ t.searchTracks }}</h3>
              <ul class="spotify-list">
                <li v-for="track in searchResult.tracks" :key="`t-${track.id}`" class="spotify-track-row">
                  <button type="button" class="spotify-track-link" @click="safeOpenUrl(track.url)">
                    <img v-if="track.imageUrl" :src="track.imageUrl" alt="" class="spotify-cover" />
                    <span class="spotify-track-meta">
                      <span class="spotify-track-name">{{ track.name }}</span>
                      <span class="spotify-track-artists">{{ t.trackBy }} {{ track.artists.join(", ") }}</span>
                    </span>
                  </button>
                </li>
              </ul>
            </section>

            <section v-if="searchResult.artists && searchResult.artists.length > 0" class="spotify-search-section">
              <h3>{{ t.searchArtists }}</h3>
              <ul class="spotify-list">
                <li v-for="artist in searchResult.artists" :key="`a-${artist.id}`" class="spotify-track-row">
                  <button type="button" class="spotify-track-link" @click="safeOpenUrl(artist.url)">
                    <img v-if="artist.imageUrl" :src="artist.imageUrl" alt="" class="spotify-cover" />
                    <span class="spotify-track-meta">
                      <span class="spotify-track-name">{{ artist.name }}</span>
                      <span v-if="artist.genres.length > 0" class="spotify-track-artists">{{ artist.genres.slice(0, 3).join(", ") }}</span>
                    </span>
                  </button>
                </li>
              </ul>
            </section>

            <section v-if="searchResult.albums && searchResult.albums.length > 0" class="spotify-search-section">
              <h3>{{ t.searchAlbums }}</h3>
              <ul class="spotify-list">
                <li v-for="album in searchResult.albums" :key="`al-${album.id}`" class="spotify-track-row">
                  <button type="button" class="spotify-track-link" @click="safeOpenUrl(album.url)">
                    <img v-if="album.imageUrl" :src="album.imageUrl" alt="" class="spotify-cover" />
                    <span class="spotify-track-meta">
                      <span class="spotify-track-name">{{ album.name }}</span>
                      <span class="spotify-track-artists">
                        {{ album.artists.join(", ") }}<template v-if="album.releaseDate"> · {{ album.releaseDate.slice(0, 4) }}</template>
                      </span>
                    </span>
                  </button>
                </li>
              </ul>
            </section>

            <section v-if="searchResult.playlists && searchResult.playlists.length > 0" class="spotify-search-section">
              <h3>{{ t.searchPlaylists }}</h3>
              <ul class="spotify-list">
                <li v-for="playlist in searchResult.playlists" :key="`p-${playlist.id}`" class="spotify-playlist-row">
                  <button type="button" class="spotify-track-link" @click="safeOpenUrl(playlist.url)">
                    <img v-if="playlist.imageUrl" :src="playlist.imageUrl" alt="" class="spotify-cover" />
                    <span class="spotify-track-meta">
                      <span class="spotify-track-name">{{ playlist.name }}</span>
                      <span class="spotify-track-artists">{{ playlist.trackCount }} {{ t.tracksCount }}</span>
                    </span>
                  </button>
                </li>
              </ul>
            </section>
          </div>
          <p v-else class="spotify-empty">{{ t.searchHint }}</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.spotify-view {
  /* `h-full + flex column` so the content area can take the
   * remaining vertical space and scroll, instead of overflowing
   * into the host's chrome below. Same shape as todo-plugin's
   * View. */
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 1rem;
  font-family:
    system-ui,
    -apple-system,
    sans-serif;
  /* Critical: a flex child whose intrinsic content is taller than
   * its allotted space won't shrink unless `min-height: 0`. Without
   * this the scrollable content area's `overflow: auto` is ignored
   * and the parent grows past the canvas. */
  min-height: 0;
}
.spotify-connected {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.spotify-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.spotify-header h2 {
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0 0 0.5rem;
}
.spotify-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: #6b7280;
  margin-bottom: 1rem;
}
.spotify-connected-pill {
  background: #1ed760;
  color: white;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 500;
}
.spotify-reconnect {
  margin-left: auto;
  background: none;
  border: 1px solid #d1d5db;
  border-radius: 0.25rem;
  padding: 0.125rem 0.5rem;
  cursor: pointer;
  font-size: 0.75rem;
  color: #374151;
}
.spotify-reconnect:hover:not(:disabled) {
  background: #f3f4f6;
}
.spotify-reconnect:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.spotify-expiry {
  font-size: 0.75rem;
  color: #9ca3af;
}
.spotify-configure {
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  padding: 1rem;
  margin-bottom: 1rem;
  background: #fafafa;
}
.spotify-configure-help {
  margin: 0 0 0.75rem;
  font-size: 0.875rem;
}
.spotify-configure-form {
  display: flex;
  gap: 0.5rem;
}
.spotify-input {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  font-family: inherit;
}
.spotify-btn-primary {
  background: #1ed760;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 0.375rem;
  font-weight: 500;
  cursor: pointer;
}
.spotify-btn-primary:disabled {
  background: #d1d5db;
  cursor: not-allowed;
}
.spotify-connect-section {
  display: flex;
  justify-content: center;
  padding: 2rem;
}
.spotify-tab-row {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid #e5e7eb;
  margin-bottom: 1rem;
}
.spotify-tabs {
  display: flex;
  gap: 0.25rem;
  flex: 1;
}
.spotify-tab {
  background: none;
  border: none;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.875rem;
  color: #6b7280;
  border-bottom: 2px solid transparent;
}
.spotify-tab-active {
  color: #1ed760;
  border-bottom-color: #1ed760;
  font-weight: 500;
}
.spotify-refresh {
  background: none;
  border: none;
  color: #6b7280;
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0 0.5rem;
}
.spotify-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.spotify-track-row,
.spotify-playlist-row {
  border-radius: 0.375rem;
}
.spotify-track-row:hover,
.spotify-playlist-row:hover {
  background: #f5f5f5;
}
.spotify-track-link {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.spotify-cover {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 0.25rem;
  object-fit: cover;
  flex-shrink: 0;
}
.spotify-track-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}
.spotify-track-name {
  font-weight: 500;
  font-size: 0.875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.spotify-track-artists {
  font-size: 0.75rem;
  color: #6b7280;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.spotify-track-album {
  font-size: 0.75rem;
  color: #9ca3af;
}
.spotify-track-duration {
  font-size: 0.75rem;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
}
.spotify-now-playing {
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  padding: 1rem;
}
.spotify-search-form {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.spotify-search-results {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.spotify-search-section h3 {
  font-size: 0.875rem;
  font-weight: 600;
  color: #6b7280;
  margin: 0 0 0.25rem;
  padding: 0;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.spotify-player,
.spotify-player-locked,
.spotify-devices {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
}
.spotify-player-locked {
  background: #fafafa;
  color: #6b7280;
}
.spotify-player h3,
.spotify-player-locked h3,
.spotify-devices h3 {
  font-size: 0.875rem;
  font-weight: 600;
  margin: 0 0 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6b7280;
}
.spotify-player-buttons {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.spotify-player-btn {
  flex: 1;
  padding: 0.5rem;
  background: #1ed760;
  color: white;
  border: none;
  border-radius: 0.375rem;
  font-size: 1rem;
  cursor: pointer;
}
.spotify-player-btn:disabled {
  background: #d1d5db;
  cursor: not-allowed;
}
.spotify-player-volume {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}
.spotify-player-volume input[type="range"] {
  flex: 1;
}
.spotify-device-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  font-size: 0.875rem;
}
.spotify-device-name {
  flex: 1;
  font-weight: 500;
}
.spotify-device-type {
  color: #6b7280;
  font-size: 0.75rem;
}
.spotify-device-active {
  background: #1ed760;
  color: white;
  padding: 0 0.5rem;
  border-radius: 9999px;
  font-size: 0.75rem;
}
.spotify-device-transfer {
  background: none;
  border: 1px solid #d1d5db;
  border-radius: 0.25rem;
  padding: 0.125rem 0.5rem;
  cursor: pointer;
  font-size: 0.75rem;
}
.spotify-now-cover {
  width: 4rem;
  height: 4rem;
  border-radius: 0.375rem;
}
.spotify-empty,
.spotify-loading {
  color: #6b7280;
  font-size: 0.875rem;
  text-align: center;
  padding: 2rem;
}
.spotify-error {
  color: #dc2626;
  font-size: 0.875rem;
  padding: 0.5rem;
  background: #fef2f2;
  border-radius: 0.375rem;
}
.spotify-retry {
  background: none;
  border: 1px solid currentColor;
  border-radius: 0.25rem;
  padding: 0.125rem 0.5rem;
  margin-left: 0.5rem;
  cursor: pointer;
  color: inherit;
  font-size: inherit;
}
</style>
