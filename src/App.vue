<template>
  <div class="flex flex-col fixed inset-0 bg-gray-900 text-white">
    <!-- Backend-offline banner (#1479) — pinned above the top bar so
         it's the first thing the user sees when the server isn't
         reachable. Self-hiding when fetchHealth succeeds. -->
    <BackendOfflineBanner :on-retry="fetchHealth" />
    <!-- Live-updates refused notice (#3433) — the pub/sub handshake was turned
         down, which after a server restart means this page holds a stale token.
         Offers a reload, the only way to fetch the new one. -->
    <LiveUpdatesRefusedBanner />
    <!-- Remote-host disconnect notice (#2535) — shown when the host was meant to
         be connected (a session is parked) but dropped and a silent reconnect
         couldn't restore it. Offers a one-click re-login. -->
    <RemoteHostOfflineBanner />
    <!-- CSP-blocked-resource notice (#1989) — a sandboxed view tried to load a
         host not allowed by config/csp.json. Tells the user the exact host +
         directive so they can extend the policy (if they trust it). -->
    <div v-if="firstCspViolation" class="shrink-0 flex items-start gap-3 bg-amber-50 text-amber-900 text-xs px-3 py-2 border-b border-amber-200" role="alert">
      <span class="flex-1 min-w-0">{{ $t("cspViolation.notice", { host: firstCspViolation.host, directive: firstCspViolation.directive }) }}</span>
      <button class="shrink-0 underline hover:no-underline" @click="dismissCspViolations()">{{ $t("cspViolation.dismiss") }}</button>
    </div>
    <!-- Global top bar — shown in every view mode -->
    <div class="shrink-0 bg-white text-gray-900">
      <!-- Row 1: title + plugin launcher -->
      <div class="flex items-center gap-2 px-3 py-2 border-b border-gray-200">
        <SidebarHeader
          :sandbox-enabled="sandboxEnabled"
          :gemini-available="geminiAvailable"
          :title-style="debugTitleStyle"
          @test-query="(q) => sendMessage(q)"
          @open-settings="showSettings = true"
          @home="handleHomeClick"
        />
        <div class="flex-1 min-w-0">
          <PluginLauncher
            :active-tool-name="selectedResult?.toolName ?? null"
            :active-view-mode="currentPage"
            :shortcuts="shortcuts"
            :active-session-count="activeSessionCount"
            :unread-count="unreadCount"
            @navigate="onPluginNavigate"
            @navigate-shortcut="onShortcutNavigate"
            @navigate-chat="handleHomeClick"
          />
        </div>
      </div>
      <!-- Row 2: role selector + session tabs. Chat-only chrome — shown
           on /chat whenever the side panel is hidden (Row 2 and the
           side panel are mutually exclusive). Off /chat the whole row
           is gone; the always-visible Chat button in Row 1 is the way
           back into a conversation. The header-controls wrapper is
           pinned to 264px (w-72 minus px-3 padding on each side) so
           RoleSelector / + / toggle occupy the exact same x-range as
           they do inside the open side panel — toggling the panel
           therefore doesn't shift those controls. -->
      <div v-if="isChatPage && !sidePanelVisible" class="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
        <div class="w-[264px] shrink-0">
          <SessionHeaderControls
            :roles="roles"
            :side-panel-visible="sidePanelVisible"
            @role-change="onRoleChange"
            @new-session="handleNewSessionClick"
            @update:side-panel-visible="setSidePanelVisible"
          />
        </div>
        <SessionTabBar :sessions="tabSessions" :current-session-id="currentSessionId" :roles="roles" @load-session="handleSessionSelect" />
      </div>
    </div>

    <!-- Body: optional session-history column + sidebar (Single only) + canvas column + right sidebar -->
    <div class="flex flex-1 min-h-0">
      <!-- Session-history side panel. Opt-in column to the left of
           the chat sidebar / canvas, toggled via
           SessionHistoryToggleButton. Chat-only chrome — renders on
           /chat when `sidePanelVisible` is true. Row 2 of the top bar
           hides when the panel is open — the panel's own header
           supplies the role selector + new-session button instead. -->
      <div
        v-if="isChatPage && sidePanelVisible"
        class="relative border-r border-gray-200 bg-white text-gray-900 flex flex-col min-w-0 overflow-hidden"
        :class="sidePanelExpanded ? 'flex-1' : 'w-72 flex-shrink-0'"
        data-testid="session-history-side-panel"
      >
        <!-- Single-row panel header. RoleSelector flexes to share the
             w-72 width with the new-session button and the side-panel
             close toggle. The expand affordance lives on the panel's
             right edge as a hover-reveal handle instead of a header
             button, so no second row is needed. -->
        <div class="flex items-center px-3 py-2 border-b border-gray-100">
          <SessionHeaderControls
            :roles="roles"
            :side-panel-visible="sidePanelVisible"
            @role-change="onRoleChange"
            @new-session="handleNewSessionClick"
            @update:side-panel-visible="setSidePanelVisibleAndCollapse"
          />
        </div>
        <div class="group relative flex-1 min-h-0">
          <SessionHistoryPanel
            :sessions="mergedSessions"
            :current-session-id="currentSessionId"
            :roles="roles"
            :error-message="historyError"
            @load-session="handleSessionSelect"
            @toggle-bookmark="(id, bookmarked) => setBookmark(id, bookmarked)"
            @delete-session="(id) => deleteSessionFromHistory(id)"
          />
          <SessionHistoryExpandButton :model-value="sidePanelExpanded" @update:model-value="(value: boolean) => (sidePanelExpanded = value)" />
        </div>
      </div>

      <!-- Sidebar (Single layout only) -->
      <div
        v-if="!isStackLayout && !sidePanelExpanded"
        class="w-80 flex-shrink-0 border-r border-gray-200 flex flex-col bg-white text-gray-900 relative"
        data-testid="chat-sidebar"
        @dragenter="onPanelDragenter"
        @dragover="onPanelDragover"
        @dragleave="onPanelDragleave"
        @drop="onPanelDrop"
      >
        <FileDropOverlay v-if="isPanelDragging" />
        <!-- Tool result previews + role header (#842) -->
        <SessionSidebar
          ref="sessionSidebarRef"
          :results="sidebarResults"
          :selected-uuid="selectedResultUuid"
          :result-timestamps="activeSession?.resultTimestamps ?? new Map()"
          :session-role-name="sessionRoleName"
          :session-role-icon="sessionRoleIcon"
          :session-model="activeSession?.resolvedModel"
          :session-model-override="activeSession?.chatModel"
          :layout-mode="layoutMode"
          :show-right-sidebar="showRightSidebar"
          :has-new-messages="hasNewWhileDetached"
          @update:session-model-override="setSessionModelOverride"
          @select="onSidebarItemClick"
          @activate="activePane = 'sidebar'"
          @update:layout-mode="setLayoutMode"
          @toggle-right-sidebar="toggleRightSidebar"
          @jump-to-latest="jumpToLatest"
        />

        <!-- Shared Thinking indicator. Sits between the sidebar and
             the chat input so the user gets the same "still alive"
             cue regardless of which plugin view fills the canvas
             (the sidebar copy inside SessionSidebar scrolls with
             results and can fall below the fold). -->
        <ThinkingIndicator
          v-if="activeSessionRunning"
          :status-message="statusMessage || t('app.thinking')"
          :run-elapsed-ms="runElapsedMs"
          :pending-calls="pendingCalls"
          class="border-t border-gray-100"
        />

        <!-- Text input -->
        <ChatInput
          ref="chatInputRef"
          v-model="userInput"
          v-model:pasted-files="pastedFiles"
          v-model:buffered-messages="currentBufferedMessages"
          :is-running="activeSessionRunning"
          :queries="sessionRoleQueries"
          :session-id="currentSessionId"
          @send="sendMessage()"
          @stop="stopCurrentRun()"
          @suggestion-send="(q) => sendMessage(q)"
        />
      </div>

      <!-- Canvas column. In stack-chat mode the canvas IS the chat
           panel (messages on top, ChatInput at the bottom), so the
           panel-wide drop zone (#1289 Step 2) applies here too. In
           single mode the canvas hosts plugin pages (Files / Wiki /
           …); we deliberately do NOT widen the drop zone onto those
           because each page handles file input on its own terms. -->
      <div v-if="!sidePanelExpanded" class="flex-1 flex flex-col bg-white text-gray-900 min-w-0 overflow-hidden relative" v-on="canvasDropHandlers">
        <FileDropOverlay v-if="isPanelDragging && isStackLayout && isChatPage" />
        <div ref="canvasRef" class="flex-1 overflow-hidden outline-none min-h-0" tabindex="0" @mousedown="activePane = 'main'" @keydown="handleCanvasKeydown">
          <!-- Chat page: single or stack layout -->
          <template v-if="isChatPage && layoutMode === 'single'">
            <component
              :is="getPlugin(selectedResult.toolName)?.viewComponent"
              v-if="selectedResult && getPlugin(selectedResult.toolName)?.viewComponent"
              :key="`${selectedResult.uuid ?? ''}-${googleMapKeyFor(selectedResult.toolName) ?? ''}`"
              :selected-result="selectedResult"
              :send-text-message="sendMessage"
              :google-map-key="googleMapKeyFor(selectedResult.toolName)"
              @update-result="handleUpdateResult"
            />
            <div v-else-if="selectedResult" class="h-full overflow-auto p-6">
              <pre class="text-sm text-gray-700 whitespace-pre-wrap">{{ JSON.stringify(selectedResult, null, 2) }}</pre>
            </div>
            <div v-else class="flex flex-col items-center justify-center h-full px-6 text-center">
              <span class="material-icons text-5xl text-gray-400 mb-2" :class="ROLE_ICON_CONTAINMENT" aria-hidden="true">{{ sessionRoleIcon }}</span>
              <p class="text-lg font-medium text-gray-700 mb-4">{{ sessionRoleName }}</p>
              <div v-if="sessionRoleQueries.length > 0" class="flex flex-wrap gap-2 justify-center max-w-xl">
                <button
                  v-for="(query, queryIdx) in sessionRoleQueries"
                  :key="`${queryIdx}-${query}`"
                  class="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full px-4 py-2 border border-gray-300 transition-colors"
                  @click="sendMessage(query)"
                >
                  {{ query }}
                </button>
              </div>
              <p v-else class="text-sm text-gray-500">{{ t("app.startConversation") }}</p>
            </div>
          </template>
          <StackView
            v-else-if="isChatPage && layoutMode === 'stack'"
            :tool-results="sidebarResults"
            :selected-result-uuid="selectedResultUuid"
            :result-timestamps="activeSession?.resultTimestamps ?? new Map()"
            :send-text-message="sendMessage"
            :queries="sessionRoleQueries"
            :session-role-name="sessionRoleName"
            :session-role-icon="sessionRoleIcon"
            :session-model="activeSession?.resolvedModel"
            :session-model-override="activeSession?.chatModel"
            :layout-mode="layoutMode"
            :show-right-sidebar="showRightSidebar"
            :google-map-key="googleMapsApiKey"
            @update:session-model-override="setSessionModelOverride"
            @select="(uuid) => (selectedResultUuid = uuid)"
            @update-result="handleUpdateResult"
            @update:layout-mode="setLayoutMode"
            @toggle-right-sidebar="toggleRightSidebar"
          />
          <!-- Distinct pages. Plugin-owned views (Automations / Wiki)
               call `useRuntime()` from
               `gui-chat-protocol/vue` inside their composables — that
               throws unless mounted under `<PluginScopedRoot>`. The
               plugin registry's `wrapWithScope` wraps the chat-mounted
               variants; standalone routes are wrapped here against the
               same `pkg-name + endpoints` pair so the `useRuntime()`
               call resolves. -->
          <!-- Dashboard — grid of favorite (pinned) collections, each a
               live embedded view. Host component (no PluginScopedRoot):
               CollectionView talks to /api/collections directly, same as
               the collections index below. -->
          <DashboardView v-else-if="currentPage === 'dashboard'" />
          <FilesView v-else-if="currentPage === 'files'" :refresh-token="filesRefreshToken" @load-session="handleSessionSelect" />
          <PluginScopedRoot v-else-if="currentPage === 'automations'" pkg-name="scheduler" :endpoints="API_ROUTES.scheduler">
            <AutomationsView />
          </PluginScopedRoot>
          <PluginScopedRoot v-else-if="currentPage === 'wiki'" pkg-name="wiki" :endpoints="API_ROUTES.wiki">
            <WikiView />
          </PluginScopedRoot>
          <CollectionView v-else-if="currentPage === 'feeds' && route.params.slug" :key="`feed-${route.params.slug}`" />
          <FeedsView v-else-if="currentPage === 'feeds'" />
          <!-- Schema-driven collections. The route is
               `/collections/:slug?`; with a slug we mount the
               CollectionView, without one we mount the index. Both
               are host components (no PluginScopedRoot needed) —
               they call the host's /api/collections endpoints
               directly. -->
          <CollectionView v-else-if="currentPage === 'collections' && route.params.slug" :key="String(route.params.slug)" />
          <CollectionsIndexView v-else-if="currentPage === 'collections'" />
          <!-- Accounting — the double-entry bookkeeping app. Host
               component (no PluginScopedRoot): the View talks to
               /api/accounting via the host's apiCall directly and never
               calls `useRuntime()`, so it needs no plugin scope. Mounted
               without a `selected-result` prop — standalone it self-fetches
               the book list and auto-selects a book on mount. -->
          <AccountingView v-else-if="currentPage === 'accounting'" />
          <!-- Debug page (encore plan PR 1 follow-up). The View ships
               inside the @mulmoclaude/debug-plugin runtime package; we
               look it up by tool name and render the registered
               viewComponent — already wrapped in PluginScopedRoot by
               the runtime loader, so no extra scope wrapper here.

               Literal English fallback below is intentional: the debug
               surface is dev-only chrome behind `VITE_DEV_MODE=1`, so
               we keep its strings out of the 8-locale i18n bundle.
               Same policy applies to the launcher button (see
               PluginLauncher.vue's `literalLabel`/`literalTitle`) and
               to the page itself (debug-plugin/src/View.vue). -->
          <component :is="debugViewComponent" v-else-if="currentPage === 'debug' && debugViewComponent" />
          <!-- eslint-disable @intlify/vue-i18n/no-raw-text -- debug page is dev-only chrome behind VITE_DEV_MODE=1; we deliberately keep its strings out of the 8-locale i18n bundle (see policy comment above). -->
          <div v-else-if="currentPage === 'debug'" class="h-full flex items-center justify-center text-sm text-gray-500">
            Debug plugin is not loaded. Make sure @mulmoclaude/debug-plugin is built and registered as a preset.
          </div>
          <!-- eslint-enable @intlify/vue-i18n/no-raw-text -->
        </div>

        <!-- Bottom bar (Stack chat only — plugin views have no
             session context, so no chat input is shown) -->
        <div v-if="isChatPage && layoutMode === 'stack'" class="border-t border-gray-200 bg-white shrink-0">
          <ThinkingIndicator
            v-if="activeSessionRunning"
            :status-message="statusMessage || t('app.thinking')"
            :run-elapsed-ms="runElapsedMs"
            :pending-calls="pendingCalls"
            class="border-t border-gray-100"
          />
          <ChatInput
            ref="chatInputRef"
            v-model="userInput"
            v-model:pasted-files="pastedFiles"
            v-model:buffered-messages="currentBufferedMessages"
            :is-running="activeSessionRunning"
            :queries="sessionRoleQueries"
            :session-id="currentSessionId"
            @send="sendMessage()"
            @stop="stopCurrentRun()"
            @suggestion-send="(q) => sendMessage(q)"
          />
        </div>
      </div>

      <!-- Right sidebar: tool call history. Only shown on the chat
           page — system prompt / tools / tool-call history are all
           agent-context and have no meaning on plugin views. -->
      <RightSidebar
        v-if="showRightSidebar && isChatPage && !sidePanelExpanded"
        ref="rightSidebarRef"
        :tool-call-history="toolCallHistory"
        :available-tools="availableTools"
        :role-prompt="sessionRole.prompt"
        :tool-descriptions="toolDescriptions"
        :session-id="activeSession?.id ?? null"
        :selected-result-uuid="selectedResultUuid"
      />
    </div>

    <!-- Global settings modal -->
    <SettingsModal
      :open="showSettings"
      :docker-mode="sandboxEnabled"
      :gemini-available="geminiAvailable"
      :gemini-env-file-path="geminiEnvFilePath"
      :mcp-tools-error="mcpToolsError"
      @update:open="onSettingsOpenChange"
      @ask-gemini="handleAskGemini"
      @saved="onSettingsSaved"
      @stopped="onServerStopped"
    />

    <!-- Rendered on the response to POST /api/shutdown, i.e. while the
         server is still answering. Once it is gone the page cannot be
         navigated anywhere, so this has to be up first (#2616). -->
    <div v-if="serverStopped" class="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900/80 p-6" data-testid="server-stopped-overlay">
      <!-- `role="alert"` (assertive by definition) rather than a dialog:
           there is nothing here to focus or dismiss, and this is the one
           state a screen-reader user most needs told — the app is gone
           and no further interaction will do anything. -->
      <div class="max-w-md rounded-lg bg-white p-6 text-center shadow-xl" role="alert" aria-live="assertive">
        <p class="text-base font-medium text-gray-900">{{ t("settingsModal.quitTab.stoppedTitle") }}</p>
        <p class="mt-2 text-sm text-gray-600">{{ t("settingsModal.quitTab.stoppedBody") }}</p>
      </div>
    </div>

    <!-- Global confirm dialog. Renders the module-global confirm state opened
         via useConfirm()/the collection plugin's confirm() capability — mounted
         here at the app root so it survives any single view (CollectionView used
         to render its own before moving into @mulmoclaude/core/collection). -->
    <ConfirmModal />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onScopeDispose, reactive } from "vue";
import { useI18n } from "vue-i18n";
import { getPlugin } from "./tools";
import type { ToolResultComplete } from "gui-chat-protocol/vue";
import BackendOfflineBanner from "./components/BackendOfflineBanner.vue";
import LiveUpdatesRefusedBanner from "./components/LiveUpdatesRefusedBanner.vue";
import RemoteHostOfflineBanner from "./components/RemoteHostOfflineBanner.vue";
import RightSidebar from "./components/RightSidebar.vue";
import SidebarHeader from "./components/SidebarHeader.vue";
import SessionHeaderControls from "./components/SessionHeaderControls.vue";
import SessionTabBar from "./components/SessionTabBar.vue";
import ChatInput, { type PastedFile } from "./components/ChatInput.vue";
import FileDropOverlay from "./components/FileDropOverlay.vue";
import SessionHistoryExpandButton from "./components/SessionHistoryExpandButton.vue";
import SessionHistoryPanel from "./components/SessionHistoryPanel.vue";
import SessionSidebar from "./components/SessionSidebar.vue";
import ThinkingIndicator from "./components/ThinkingIndicator.vue";
import PluginLauncher from "./components/PluginLauncher.vue";
import DashboardView from "./components/DashboardView.vue";
import StackView from "./components/StackView.vue";
import FilesView from "./components/FilesView.vue";
import AutomationsView from "./plugins/scheduler/AutomationsView.vue";
import WikiView from "./plugins/wiki/View.vue";
import { AccountingView } from "@mulmoclaude/accounting-plugin/vue";
import { buildWikiRouteParams } from "@mulmoclaude/core/wiki";
import { CollectionView, CollectionsIndexView, FeedsView } from "@mulmoclaude/collection-plugin/vue";
import PluginScopedRoot from "./components/PluginScopedRoot.vue";
import SettingsModal from "./components/SettingsModal.vue";
import { PAGE_ROUTES, type PageRouteName } from "./router";
import type { ActiveSession } from "./types/session";
import { EVENT_TYPES } from "./types/events";
import { buildAgentRequestBody, postAgentRun } from "./utils/agent/request";
import { resolvePastedAttachment, type ResolvedAttachment } from "./utils/agent/pastedAttachment";
import { applyAgentEvent, type AgentEventContext } from "./utils/agent/eventDispatch";
import { parseSseEvent } from "./utils/agent/parseSseEvent";
import { pushErrorMessage, beginUserTurn, updateResult, applyToolResultToSession } from "./utils/session/sessionHelpers";
import { resolveRequestedRoleId } from "./utils/session/roleSelection";
import { parseCollectionSlashSeed, makeSyntheticCollectionResult, hasRealCollectionResult } from "./utils/collections/presentSeed";
import { mergeBufferedIntoDraft } from "./utils/chat/buffer";
import { createInFlightShare } from "./utils/inFlightShare";
import { ROLE_ICON_CONTAINMENT, roleName, roleIcon } from "./utils/role/icon";
import { usePendingCalls } from "./composables/usePendingCalls";
import { loadCspExtra } from "./composables/useCspExtra";
import { cspViolations, dismissCspViolations, installCspViolationListener } from "./composables/useCspViolations";
import { useRunElapsed } from "./composables/useRunElapsed";
import { useKeyNavigation } from "./composables/useKeyNavigation";
import { useDebugBeat } from "./composables/useDebugBeat";
import { useChatScroll } from "./composables/useChatScroll";
import { useFileDropZone } from "./composables/useFileDropZone";
import { useViewLayout } from "./composables/useViewLayout";
import { useChatDrafts } from "./composables/useChatDrafts";
import { useSessionSync } from "./composables/useSessionSync";
import { useSessionLifecycle } from "./composables/useSessionLifecycle";
import { useSessionDerived } from "./composables/useSessionDerived";
import { useFaviconState } from "./composables/useFaviconState";
import { useGlobalImageErrorRepair } from "./composables/useImageErrorRepair";
import { useMergedSessions } from "./composables/useMergedSessions";
import { useLayoutMode } from "./composables/useLayoutMode";
import { useSidePanelVisible } from "./composables/useSidePanelVisible";
import { useMcpTools } from "./composables/useMcpTools";
import { useRoles } from "./composables/useRoles";
import { useCurrentRole } from "./composables/useCurrentRole";
import { useShortcuts } from "./composables/useShortcuts";
import type { Shortcut } from "./types/shortcuts";
import { useTranslatedQueries } from "./composables/useTranslatedQueries";
import { BUILTIN_ROLE_IDS, ROLES, type Role } from "./config/roles";
import { usePubSub } from "./composables/usePubSub";
import { sessionChannel } from "./config/pubsubChannels";
import ConfirmModal from "./components/ConfirmModal.vue";
import { useNotifications } from "./composables/useNotifications";
import { collectionNotifiedSeverities } from "./utils/collections/notifiedItems";
import { installCollectionAppBindings } from "./composables/collections/uiHost";
import { useDynamicShortcutIcons } from "./composables/collections/useDynamicShortcutIcons";
import type { CollectionsListResponse } from "@mulmoclaude/core/collection";
import { useHealth } from "./composables/useHealth";
import { useSessionHistory } from "./composables/useSessionHistory";
import { useRightSidebar } from "./composables/useRightSidebar";
import { useEventListeners } from "./composables/useEventListeners";
import { provideAppApi } from "./composables/useAppApi";
import { provideActiveSession } from "./composables/useActiveSession";
import { useRoute, useRouter } from "vue-router";
import { apiGet, apiPost } from "./utils/api";
import { API_ROUTES } from "./config/apiRoutes";
import type { ChatModel } from "./config/models";
import { TOOL_NAMES } from "./config/toolNames";
import { classifyWorkspacePath } from "./utils/path/workspaceLinkRouter";

const { t, locale } = useI18n();

// --- Per-session state ---
// Declared early so that pub/sub callbacks and function declarations
// below can reference them without forward-reference ambiguity.
const sessionMap = reactive(new Map<string, ActiveSession>());

// Tracks active pub/sub subscriptions per session. The unsubscribe
// function is stored so we can clean up when the session is removed
// from memory. Sessions that are running always have an active
// subscription so events arrive via WebSocket.
const sessionSubscriptions = new Map<string, () => void>();

// currentSessionId is "the session currently displayed on /chat" —
// it's `""` whenever the user is on any other page. A plain ref (not
// a computed) so synchronous writes (e.g. inside createNewSession,
// which is called right before sendMessage might run) take effect
// immediately. The URL is kept in sync via navigateToSession, and
// external URL changes (back button, typed URL) feed back into the
// ref via the route watcher below. An `isChatPage` watcher clears
// it when the user leaves /chat.
const currentSessionId = ref("");

// --- Debug beat (pub/sub) ---
const { debugTitleStyle } = useDebugBeat();

const { subscribe: pubsubSubscribe, onReconnect: pubsubOnReconnect } = usePubSub();

// --- Routing ---
const route = useRoute();
const router = useRouter();

// --- Global state ---
// `roles` is the merged list (built-in + custom). `currentRoleId`
// is the role-selector dropdown's current pick — App.vue reads it
// as the fallback in createNewSession() so plugin callers like
// wiki's `appApi.startNewChat(message)` (no roleId) start their
// chat in whatever role the user last selected, instead of silently
// reverting to the first built-in role. Writes to `currentRoleId`
// happen only inside SessionHeaderControls (the dropdown owner).
// Code that needs "the role of the conversation in progress" reads
// `sessionRole` below, which derives from the active session.
const { roles, refreshRoles } = useRoles();
const { currentRoleId } = useCurrentRole(roles);

// Pinned launcher shortcuts (collections / feeds). The host owns the
// list and passes it down; the launcher stays presentational.
const { shortcuts } = useShortcuts();

// Unsent composer state — draft text and staged attachments — keyed by
// session (#2811). Reads/writes look like plain refs, but each session
// keeps its own, and the text is mirrored into sessionStorage so a
// reload restores what the user was typing. Every place that assigns
// `userInput.value` therefore also updates storage — including the
// clears in sendMessage.
const { userInput, pastedFiles, restoreDraft, dropDraft: dropSessionDraft } = useChatDrafts(currentSessionId);
// Messages the user sends while a run is in flight queue here instead of
// dispatching, keyed by the session they belong to so concurrent runs in
// different sessions never mix. `currentBufferedMessages` is the displayed
// session's queue; it merges back into `userInput` when that session's run
// finishes (see watch below).
const bufferedMessagesBySession = ref<Record<string, string[]>>({});
const currentBufferedMessages = computed<string[]>({
  get: () => bufferedMessagesBySession.value[currentSessionId.value] ?? [],
  set: (messages) => {
    bufferedMessagesBySession.value = { ...bufferedMessagesBySession.value, [currentSessionId.value]: messages };
  },
});
const activePane = ref<"sidebar" | "main">("sidebar");

const { sessions, historyError, fetchSessions, setBookmark, deleteSession: deleteSessionFromHistory } = useSessionHistory();
const { geminiAvailable, geminiEnvFilePath, sandboxEnabled, cpuLoadRatio, fetchHealth } = useHealth();

const { activeSession, toolResults, sidebarResults, isRunning, activeSessionRunning, statusMessage, toolCallHistory, activeSessionCount, unreadCount } =
  useSessionDerived({ sessionMap, currentSessionId, sessions });

const selectedResultUuid = computed<string | null>({
  get: () => activeSession.value?.selectedResultUuid ?? null,
  set: (val) => {
    if (activeSession.value) activeSession.value.selectedResultUuid = val;
  },
});

// This conversation's one-off model override (#3147). Written straight to
// session meta so it survives a reload; the local session object is updated
// optimistically because the chip must not lag the click, and the next turn
// reads the persisted value rather than this copy.
const pendingModelWrite = ref<Promise<void> | null>(null);

async function persistSessionModelOverride(session: ActiveSession, model: ChatModel | undefined): Promise<void> {
  const previous = session.chatModel;
  if (model) session.chatModel = model;
  else delete session.chatModel;
  const path = API_ROUTES.sessions.chatModel.replace(":id", encodeURIComponent(session.id));
  const result = await apiPost<{ ok: boolean }>(path, { chatModel: model ?? null });
  if (result.ok) return;
  // Put the old value back rather than leaving the chip claiming a setting the
  // server rejected — a silent disagreement between screen and disk is the
  // thing #2554 existed to end.
  if (previous) session.chatModel = previous;
  else delete session.chatModel;
}

// Queued, and `sendMessage` waits on the queue before it dispatches: the next
// turn reads this choice from DISK, so a send issued straight after a
// selection would otherwise overtake the write and run on the previous
// cascade. Chaining also lands two quick selections in the order they were
// clicked, which two independent requests do not guarantee.
async function setSessionModelOverride(model: ChatModel | undefined): Promise<void> {
  const session = activeSession.value;
  if (!session) return;
  const queued = (pendingModelWrite.value ?? Promise.resolve()).then(() => persistSessionModelOverride(session, model));
  pendingModelWrite.value = queued.catch(() => undefined);
  await queued;
}

// Display name and icon of the role the active session was created
// under, so the message list can show which role is driving the
// conversation (independent of what the dropdown currently shows).
const sessionRoleName = computed(() => {
  const roleId = activeSession.value?.roleId;
  if (!roleId) return "";
  return roleName(roles.value, roleId);
});
const sessionRoleIcon = computed(() => {
  const roleId = activeSession.value?.roleId;
  if (!roleId) return "";
  return roleIcon(roles.value, roleId);
});

// The role a given conversation runs under. `roles` always carries the
// built-ins (merge keeps them), so its first entry is the effective
// default; ROLES[0] only covers the type.
function roleOfSession(session: ActiveSession | undefined): Role {
  const match = session?.roleId ? roles.value.find((role) => role.id === session.roleId) : undefined;
  return match ?? roles.value[0] ?? ROLES[0];
}

// Role of the conversation in progress. Drives the suggested-query
// list, the right-sidebar role-prompt, and the MCP tool filter so
// they all match the active session (not the role-selector
// dropdown — which is owned by SessionHeaderControls and whose
// selection only matters at "+" / role-change time).
const sessionRole = computed<Role>(() => roleOfSession(activeSession.value));

// Translated suggested-query strings for the active session's role.
// Falls back to the role's English source until /api/translation
// returns; subsequent role swaps hit the in-memory cache.
const currentLocale = computed(() => String(locale.value));
const { queries: sessionRoleQueries } = useTranslatedQueries(sessionRole, currentLocale);

const { mergedSessions, tabSessions } = useMergedSessions({
  sessionMap,
  sessions,
});

// ── Dynamic favicon (#470) ──────────────────────────────────
// Every input here is global, not per-on-screen-session: the user
// is often on /files or other non-chat views, so the favicon has
// to react to the whole session list rather than `activeSession`.
//
// `isRunning` is the global scan from useSessionDerived (sessionMap +
// server summaries), and `mergedSessions` folds the in-memory
// `updatedAt` / `pendingGenerations` over server summaries — so the
// runningLong clock picks up `beginUserTurn`'s local stamp on the
// very same tick as `isRunning` flips, without waiting for the next
// /api/sessions refetch.
useFaviconState({ isRunning, sessions: mergedSessions, sessionsUnreadCount: unreadCount, cpuLoadRatio });
useGlobalImageErrorRepair();
// Boot-time plugin META aggregator collisions surface as notifier
// entries from the server side; the notifier engine's persistent
// `active.json` covers the late-mount case (PR 4 of feat-encore),
// so no client-side catch-up fetch is required here.

const sessionSidebarRef = ref<{ root: HTMLDivElement | null } | null>(null);
const canvasRef = ref<HTMLDivElement | null>(null);
const chatInputRef = ref<{
  focus: () => void;
  collapseSuggestions: () => void;
  addFiles: (files: File[]) => void;
  refreshVoiceAvailability: () => Promise<void>;
} | null>(null);

const { focusChatInput, jumpToLatest, hasNewWhileDetached } = useChatScroll({
  sessionSidebarRef,
  toolResults,
  isRunning: activeSessionRunning,
  chatInputRef,
  sessionId: computed(() => activeSession.value?.id ?? null),
});

// Panel-wide file drop (#1289 Step 2). The handlers are bound on
// both the sidebar (single layout) and the stack-mode canvas column;
// the same `chatInputRef` is reused across layouts because only one
// ChatInput is mounted at a time (v-if'd). The composable also
// installs a window-level guard so a drop OUTSIDE the panel still
// `preventDefault`s — the browser would otherwise navigate to the
// file and the user would lose their in-progress conversation.
const {
  isDragging: isPanelDragging,
  onDragenter: onPanelDragenter,
  onDragover: onPanelDragover,
  onDragleave: onPanelDragleave,
  onDrop: onPanelDrop,
} = useFileDropZone({
  onFiles: (files) => {
    chatInputRef.value?.addFiles(files);
  },
});

const { showRightSidebar, toggleRightSidebar } = useRightSidebar();
const showSettings = ref(false);
// Set when the server acknowledged POST /api/shutdown. One-way: nothing
// can clear it, because there is no server left to talk to (#2616).
const serverStopped = ref(false);
function onServerStopped(): void {
  // Close the modal too: leaving it open puts a live-looking settings
  // pane behind the "stopped" card, which reads as if something still
  // works. Nothing does — the server is gone.
  showSettings.value = false;
  serverStopped.value = true;
}

// When the Settings modal closes, re-check voice-input availability: the
// user may have just enabled it / started the model download, and the
// mic button should appear without a reload (the composable then polls
// until the download finishes). See plans/done/feat-voice-input.md.
function onSettingsOpenChange(open: boolean): void {
  showSettings.value = open;
  if (!open) chatInputRef.value?.refreshVoiceAvailability()?.catch(() => undefined);
}

const { layoutMode, setLayoutMode } = useLayoutMode();
const { sidePanelVisible, setSidePanelVisible } = useSidePanelVisible();
// Transient full-width mode for the session-history side panel.
// Not persisted: reopening the panel should always start collapsed.
const sidePanelExpanded = ref(false);

function setSidePanelVisibleAndCollapse(value: boolean): void {
  setSidePanelVisible(value);
  if (!value) sidePanelExpanded.value = false;
}

// Current page derives from the route. The chat page has a layout
// preference on top (single vs. stack); other pages are distinct
// full-width views.
const isChatPage = computed(() => route.name === PAGE_ROUTES.chat);
const currentPage = computed<PageRouteName | null>(() => {
  const { name } = route;
  return typeof name === "string" && isPageRouteName(name) ? name : null;
});

// Session lifecycle (create / switch / load / resume). The event-stream
// hook `ensureSessionSubscription` (a hoisted function below) is injected
// so this composable stays out of the pub/sub concern.
const { removeCurrentIfEmpty, createNewSession, onRoleChange, loadSession, refreshSessionTranscript, resumeOrCreateChatSession } = useSessionLifecycle({
  sessionMap,
  currentSessionId,
  isChatPage,
  roles,
  currentRoleId,
  sessions,
  mergedSessions,
  ensureSessionSubscription,
  focusChatInput,
  collapseChatSuggestions: () => chatInputRef.value?.collapseSuggestions(),
  dropSessionDraft,
});

const { markSessionRead, refreshSessionStates } = useSessionSync({
  sessionMap,
  currentSessionId,
  fetchSessions,
  // Another tab hard-deleted the chat we're currently viewing. The
  // sessionMap eviction has already cleared the in-memory state; the
  // URL still points at the dead id. Mirror the URL→404 fallback in
  // loadSession by spinning up a fresh session so the user lands on a
  // working /chat instead of a blank pane.
  onCurrentSessionDeleted: () => createNewSession(),
  // Covers deletions from this tab too: the server broadcasts every
  // hard delete on the sessions channel, so this is the one place a
  // deleted session's draft has to be forgotten.
  onSessionDeleted: dropSessionDraft,
  // A missed `session_finished` skipped its refresh and read mark; the
  // session list is what noticed the run ended.
  onSessionStopped: (sessionId) => {
    handleRecoveredStop(sessionId).catch((err: unknown) => {
      console.warn("[chat-ui] recovering a missed session_finished failed:", err);
    });
  },
  lastFetchFailed: () => historyError.value !== null,
});

// External URL changes (back/forward button, typed URL) → update ref.
// If the session isn't in memory, load it from the server.
watch(
  () => route.params.sessionId,
  async (newId) => {
    if (typeof newId !== "string" || newId === currentSessionId.value) return;
    currentSessionId.value = newId;
    if (!sessionMap.has(newId)) {
      await loadSession(newId);
      if (!sessionMap.has(newId)) {
        createNewSession();
      }
    }
  },
);

// Refresh the files tree after each agent run so newly written files
// appear without a manual reload.
const filesRefreshToken = ref(0);
watch(isRunning, (running, prev) => {
  if (prev && !running) filesRefreshToken.value++;
});

// Opening the side panel refreshes the session list so stale entries
// don't linger after long idle periods. `fetchSessions` is diff-based
// (cursor-aware) so the extra call is cheap when nothing changed.
watch(sidePanelVisible, (visible, prev) => {
  if (!prev && visible) {
    fetchSessions().catch((err) => console.error("[side-panel] session fetch failed:", err));
  }
});

function onPluginNavigate(target: { key: string }): void {
  if (isPageRouteName(target.key)) {
    router.push({ name: target.key }).catch(() => {});
  }
}

function isPageRouteName(value: string): value is PageRouteName {
  return Object.values(PAGE_ROUTES).some((routeName) => routeName === value);
}

// A pinned shortcut reuses the existing collection / feed routes — the
// host gains no shortcut-specific navigation logic beyond mapping the
// singular `kind` to the plural route name.
function onShortcutNavigate(shortcut: Shortcut): void {
  const name = shortcut.kind === "feed" ? PAGE_ROUTES.feeds : PAGE_ROUTES.collections;
  router.push({ name, params: { slug: shortcut.slug } }).catch(() => {});
}

// Layout only matters on /chat; other pages are full-width by design.
const { isStackLayout } = useViewLayout({
  layoutMode,
  isChatPage,
  activePane,
});

// Canvas-column drop handlers are conditional: only attach in
// stack-chat mode. Single-mode canvas shows plugin pages (Files /
// Wiki / …) whose own drop handling we don't want to shadow.
// v-on with an empty object is a no-op in Vue 3, so the canvas
// listens to nothing on single-mode chat / non-chat pages.
const canvasDropHandlers = computed(() =>
  isStackLayout.value && isChatPage.value
    ? {
        dragenter: onPanelDragenter,
        dragover: onPanelDragover,
        dragleave: onPanelDragleave,
        drop: onPanelDrop,
      }
    : {},
);

// Clear currentSessionId when the user leaves /chat so downstream
// consumers (history-panel border, mark-read, unread dot, session-
// state sync) see "nothing selected" instead of the stale last-viewed
// session. Also prune any empty session that was never sent to — we
// don't persist empty sessions on the server. Fires true → false only;
// an empty → /chat transition is handled by the route-params watcher
// and onMounted.
//
// Also collapse the side panel's transient full-width mode. The panel
// itself is chat-only chrome (`isChatPage && sidePanelVisible`), so it
// unmounts off /chat — but the canvas/sidebar stay gated by
// `!sidePanelExpanded`. Without this reset, leaving /chat while expanded
// would unmount the panel AND keep the canvas hidden, blanking plugin
// pages until the panel is collapsed again.
watch(isChatPage, (isChat, wasChat) => {
  if (!(wasChat && !isChat)) return;
  removeCurrentIfEmpty();
  currentSessionId.value = "";
  sidePanelExpanded.value = false;
});

function handleSessionSelect(sessionId: string): void {
  sidePanelExpanded.value = false;
  loadSession(sessionId);
}

function handleNewSessionClick(roleId: string): void {
  sidePanelExpanded.value = false;
  createNewSession(roleId);
}

function handleHomeClick(): void {
  resumeOrCreateChatSession().catch((err) => console.error("[home] resume failed:", err));
}

const rightSidebarRef = ref<InstanceType<typeof RightSidebar> | null>(null);

const { availableTools, toolDescriptions, mcpToolsError, fetchMcpToolsStatus } = useMcpTools({
  currentRole: sessionRole,
  getDefinition: (name) => getPlugin(name)?.toolDefinition ?? null,
});

const { pendingCalls, teardown: teardownPendingCalls } = usePendingCalls({
  isRunning: activeSessionRunning,
  toolCallHistory,
});

// Run-level elapsed time for the Thinking indicator (#731 PR2).
// Pure UI: ticks once per second while the active session is running,
// flips back to null on completion. No backend or schema changes.
const { elapsedMs: runElapsedMs, teardown: teardownRunElapsed } = useRunElapsed({
  isRunning: activeSessionRunning,
});

const selectedResult = computed(() => toolResults.value.find((result) => result.uuid === selectedResultUuid.value) ?? null);

// Debug-plugin View component, looked up by tool name. The plugin
// loader populates this asynchronously at boot — `runtimeRegistry` is
// reactive, so this computed re-evaluates when the load completes and
// the /debug branch in the template lights up without a refresh.
const debugViewComponent = computed(() => getPlugin("manageDebug")?.viewComponent ?? null);

// Google Maps API key from `AppSettings.googleMapsApiKey`. Fetched
// once on mount and refreshed whenever Settings reports a save.
//
// **Scoping**: the key is forwarded ONLY to the `mapControl` plugin
// view (= `@gui-chat-plugin/google-map`). Forwarding it to every
// plugin's `<component :is>` mount would let any third-party
// runtime plugin declare a `googleMapKey` prop and read the key.
// `googleMapKeyFor(toolName)` is the gate every binding goes
// through.
const googleMapsApiKey = ref<string | null>(null);
async function refreshGoogleMapsApiKey(): Promise<void> {
  const response = await apiGet<{ settings: { extraAllowedTools: string[]; googleMapsApiKey?: string } }>(API_ROUTES.config.base);
  if (response.ok) {
    googleMapsApiKey.value = response.data.settings.googleMapsApiKey ?? null;
  }
}
// Any Settings save. The Map key and the Gemini key live in different
// stores and the modal emits one event for both, so both are re-read: the
// Gemini one through `/api/health`, which is what clears the gear badge.
async function onSettingsSaved(): Promise<void> {
  await Promise.all([refreshGoogleMapsApiKey(), fetchHealth()]);
}

void refreshGoogleMapsApiKey();
void loadCspExtra();
installCspViolationListener();
// The banner names one blocked host; the rest of the list is deduped
// behind it and surfaces once the user extends the policy.
const firstCspViolation = computed(() => cspViolations.value[0]);

function googleMapKeyFor(toolName: string | undefined): string | null {
  return toolName === TOOL_NAMES.mapControl ? googleMapsApiKey.value : null;
}

// Centralised session-switch handler: subscribe to the current session's
// pub/sub channel so we receive real-time events even if the session is
// idle (another tab may start a run). Unsubscribe from idle sessions
// when switching away (running sessions keep their subscription so they
// continue receiving events — session_finished will clean them up).
let previousSessionId: string | null = null;
watch(currentSessionId, (sessionId) => {
  const session = sessionMap.get(sessionId);
  // Subscribe to the new session's channel
  if (session) {
    ensureSessionSubscription(session);
  }
  // Unsubscribe from the previous session if it's not running and has
  // no in-flight background generations. Tearing down the subscription
  // while a generation is still running would orphan its completion
  // event, leaving the session's busy indicator stuck on.
  if (previousSessionId && previousSessionId !== sessionId) {
    const prevSession = sessionMap.get(previousSessionId);
    if (prevSession !== undefined) {
      const prevBusy = prevSession.isRunning || Object.keys(prevSession.pendingGenerations ?? {}).length > 0;
      if (!prevBusy) {
        unsubscribeSession(previousSessionId);
      }
    }
  }
  previousSessionId = sessionId;
});

// Clearing unread keys off the transcript arriving, not off the click.
// currentSessionId now moves ahead of the fetch (#2809), so a session
// whose load then fails would otherwise lose its unread badge without
// ever having been read — and a transcript that 500s while its meta
// sidecar is healthy leaves the server happy to accept the mark-read.
// activeSession only becomes defined once the session is in sessionMap,
// which covers both switching to an already-loaded session and a
// just-completed load.
watch(activeSession, (session) => {
  if (!session) return;
  // Clear in both sessionMap and the sessions list (for badge count),
  // then tell the server so other tabs see it too.
  const summary = sessions.value.find((entry) => entry.id === session.id);
  if (!(session.hasUnread || summary?.hasUnread)) return;
  session.hasUnread = false;
  if (summary) summary.hasUnread = false;
  markSessionRead(session.id);
});

const { handleCanvasKeydown, handleKeyNavigation } = useKeyNavigation({
  canvasRef,
  activePane,
  sidebarResults,
  selectedResultUuid,
});

function handleUpdateResult(updatedResult: ToolResultComplete) {
  if (activeSession.value) updateResult(activeSession.value, updatedResult);
}

function onSidebarItemClick(uuid: string) {
  selectedResultUuid.value = uuid;
}

function buildAgentEventContext(session: ActiveSession): AgentEventContext {
  const sessionId = session.id;
  return {
    get session() {
      return sessionMap.get(sessionId) ?? session;
    },
    refreshRoles,
    scrollSidebarToBottom: () => rightSidebarRef.value?.scrollToBottom(),
    onGenerationsDrained: () => {
      if (currentSessionId.value === sessionId) {
        markSessionRead(sessionId);
      }
    },
  };
}

function hasPendingGenerations(sessionId: string): boolean {
  const live = sessionMap.get(sessionId);
  if (live === undefined) return false;
  return Object.keys(live.pendingGenerations).length > 0;
}

function handleSessionFinished(sessionId: string): void {
  // Trust the definitive server signal and flip the local indicator
  // immediately (#1915 Fix A). Without this, the "thinking" spinner stays
  // stuck until the `sessions` channel notification arrives via a separate
  // socket.io frame — which can go missing on a network hiccup or on
  // Safari's tab-throttling flow while the sessionChannel frame did land.
  const session = sessionMap.get(sessionId);
  if (session) {
    session.isRunning = false;
    session.statusMessage = "";
  }
  refreshSessionTranscript(sessionId).catch((err) => {
    console.error("[handleSessionFinished] refresh failed:", err);
  });
  if (currentSessionId.value === sessionId) {
    markSessionRead(sessionId);
  } else if (!hasPendingGenerations(sessionId)) {
    unsubscribeSession(sessionId);
  }
}

// A stop the session list found rather than `session_finished` announced. The
// finished turn may not be on screen yet, so unlike `handleSessionFinished` this
// never marks the session read — opening the session does that, once the user
// can see it.
async function handleRecoveredStop(sessionId: string): Promise<void> {
  const decision = await refreshSessionTranscript(sessionId);
  if (currentSessionId.value === sessionId || decision === "running") return;
  if (!hasPendingGenerations(sessionId)) unsubscribeSession(sessionId);
}

// After the client silently loses events, this pulls fresh state from the
// server so the UI recovers without a page reload (#1915). Two trigger
// surfaces:
//   - socket.io reconnect (network hiccup, WS bounce)
//   - document visibility flips to `visible` (Safari's silent tab
//     throttling — WS keeps `connected` on the server but delivery stops
//     while the tab is backgrounded, and there's no `disconnect` event to
//     hook on reconnect)
// BOTH surfaces have to stay: neither detects every case the other does.
// They do, however, fire together on the common path — Chrome throttles a
// backgrounded tab until the socket drops, so returning to it reconnects
// AND flips visibility at once. Sharing the pass keeps the coverage while
// running the work once (#2584): `GET /api/sessions` walks every session
// in the window with two stats + a meta read each, so a duplicate pass is
// ~1500 syscalls on a 488-session workspace, for nothing.
//
// refreshSessionStates() carries its own sequence guard inside
// useSessionSync so concurrent catch-ups can't overwrite newer live state
// with an older-but-slower response. refreshSessionTranscript() only
// upgrades toolResults when the server view is strictly larger, so it's
// already idempotent against interleaving. Both guards stay — they cover
// interleaving with LIVE events, which the share does not touch.
// The transcript half is keyed by session, not shared globally: a pass
// can take seconds on a large workspace, and `loadSession` reuses an
// already-visited session WITHOUT re-fetching. A trigger arriving after
// the user moved on must refresh the session they are now looking at,
// not join the pass still fetching the previous one.
const catchUpShare = createInFlightShare();
const SESSION_LIST_KEY = "sessions";

function catchUpMissedEvents(reason: "reconnect" | "visibility"): void {
  const currentId = currentSessionId.value;
  const joining = catchUpShare.isRunning(SESSION_LIST_KEY);
  console.info(joining ? `[chat-ui] catch-up after ${reason} joined the pass already running` : `[chat-ui] catching up after ${reason}`);

  void catchUpShare.run(SESSION_LIST_KEY, () =>
    refreshSessionStates().catch((err: unknown) => {
      console.warn("[chat-ui] refreshSessionStates failed:", err);
    }),
  );
  if (!currentId) return;
  void catchUpShare.run(`transcript:${currentId}`, async () => {
    try {
      await refreshSessionTranscript(currentId);
    } catch (err: unknown) {
      console.warn("[chat-ui] refreshSessionTranscript failed:", err);
    }
  });
}

// Capture the unsubscribe so remount / HMR doesn't accumulate stale
// module-level reconnect handlers (Codex review).
const unsubReconnect = pubsubOnReconnect(() => catchUpMissedEvents("reconnect"));

function handleVisibilityChange(): void {
  if (document.visibilityState === "visible") {
    catchUpMissedEvents("visibility");
  }
}

onMounted(() => {
  document.addEventListener("visibilitychange", handleVisibilityChange);
});
onScopeDispose(() => {
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  unsubReconnect();
});

function createSessionEventHandler(session: ActiveSession, ctx: AgentEventContext): (data: unknown) => void {
  return (data: unknown) => {
    const event = parseSseEvent(data);
    if (!event) return;
    if (event.type === EVENT_TYPES.sessionFinished) {
      handleSessionFinished(session.id);
      return;
    }
    applyAgentEvent(event, ctx).catch((err) => {
      console.error("[applyAgentEvent] unhandled:", err);
    });
  };
}

function ensureSessionSubscription(session: ActiveSession): void {
  if (sessionSubscriptions.has(session.id)) return;
  const ctx = buildAgentEventContext(session);
  const handler = createSessionEventHandler(session, ctx);
  const unsub = pubsubSubscribe(sessionChannel(session.id), handler);
  sessionSubscriptions.set(session.id, unsub);
}

function unsubscribeSession(chatSessionId: string): void {
  const unsub = sessionSubscriptions.get(chatSessionId);
  if (unsub) {
    unsub();
    sessionSubscriptions.delete(chatSessionId);
  }
}

type AttachmentResult = { attachments: ResolvedAttachment[] } | { error: string } | null;

async function resolveAttachments(files: PastedFile[]): Promise<AttachmentResult> {
  if (files.length === 0) return null;
  const results = await Promise.all(files.map((file) => resolvePastedAttachment(file)));
  const firstFailure = results.find((res) => !res.ok);
  if (firstFailure && !firstFailure.ok) return { error: firstFailure.error };
  const attachments = results.filter((res): res is { ok: true; value: ResolvedAttachment } => res.ok).map((res) => res.value);
  return attachments.length > 0 ? { attachments } : null;
}

async function sendMessage(text?: string) {
  const fromInput = typeof text !== "string";
  const message = fromInput ? userInput.value.trim() : text.trim();
  if (!message) return;
  // Run in flight: queue instead of dispatching. The input isn't locked,
  // so the user keeps composing; queued lines come back on completion.
  if (activeSessionRunning.value) {
    currentBufferedMessages.value = [...currentBufferedMessages.value, message];
    if (fromInput) userInput.value = "";
    return;
  }
  userInput.value = "";
  const filesSnapshot = [...pastedFiles.value];
  pastedFiles.value = [];

  // Uploading the attachments is a real round trip, so the user can be
  // looking at another session by the time it resolves. Everything past
  // this point addresses the session the message was composed in: a
  // failed send must not overwrite the displayed session's draft, and a
  // successful one must not land in the conversation the user happens
  // to be reading — under that session's role, at that.
  const originSessionId = currentSessionId.value;
  const resolved = await resolveAttachments(filesSnapshot);
  if (resolved !== null && "error" in resolved) {
    // Gone means deleted mid-upload: its draft was dropped with it, and
    // handing one back would strand text nothing can ever display.
    const recoverySession = sessionMap.get(originSessionId);
    if (!recoverySession) return;
    restoreDraft(originSessionId, message, filesSnapshot);
    pushErrorMessage(recoverySession, t("chatInput.attachImageFailed", { error: resolved.error }));
    return;
  }
  const attachments = resolved?.attachments;

  const session = sessionMap.get(originSessionId);
  if (!session) return;

  beginUserTurn(session, message, attachments);
  ensureSessionSubscription(session);

  // The override is persisted by its own request and a later turn reads it
  // from disk, so the write is the barrier — not the click that started it.
  // The model is read AFTER this await, deliberately: the await is on the
  // LATEST queued write, so by the time it returns every selection made
  // before Send has been applied. Reading before it sends the value from
  // before the queue drained — the picker would show one model and the first
  // turn would run another.
  await pendingModelWrite.value;
  const { chatModel } = session;
  const result = await postAgentRun(
    buildAgentRequestBody({
      message,
      role: roleOfSession(session),
      chatSessionId: session.id,
      attachments,
      chatModel,
    }),
  );
  if (!result.ok) {
    pushErrorMessage(session, result.error);
    unsubscribeSession(session.id);
  }
}

// Drain the displayed session's queued messages back into the input once
// its run finishes. Keyed by `currentSessionId`, so switching to another
// session shows (and later drains) that session's own queue — a background
// run in a different session never dumps its queue into the wrong input.
watch([activeSessionRunning, currentSessionId], () => {
  if (activeSessionRunning.value) return;
  const queued = currentBufferedMessages.value;
  if (queued.length === 0) return;
  userInput.value = mergeBufferedIntoDraft(queued, userInput.value);
  currentBufferedMessages.value = [];
  focusChatInput();
});

// Stop the in-flight agent run for the displayed session. The server's
// /api/agent/cancel aborts the AbortController, kills the Claude
// subprocess, and publishes `session_finished` — which flips
// `isRunning` back to false through the normal pub/sub path. So we only
// fire-and-report here; no local state reset is needed on success.
async function stopCurrentRun(): Promise<void> {
  const sessionId = currentSessionId.value;
  if (!sessionId) return;
  const result = await apiPost<{ ok: boolean }>(API_ROUTES.agent.cancel, { chatSessionId: sessionId });
  if (!result.ok) {
    const session = sessionMap.get(sessionId);
    if (session) pushErrorMessage(session, t("chatInput.stopFailed", { error: result.error }));
  }
}

// Route workspace-internal links (wiki pages, files, sessions) to the
// appropriate page. Called from plugin Views via AppApi.
function navigateToWorkspacePath(href: string): void {
  const target = classifyWorkspacePath(href);
  if (!target) return;

  switch (target.kind) {
    case "wiki":
      router.push({ name: PAGE_ROUTES.wiki, params: buildWikiRouteParams({ kind: "page", slug: target.slug }) }).catch(() => {});
      break;
    case "file":
      // Path-based files URL (see plans/done/feat-files-path-url.md) — pass
      // segments as an array so each piece is url-encoded independently
      // and slashes stay as path separators.
      router.push({ name: PAGE_ROUTES.files, params: { pathMatch: target.path.split("/") } }).catch(() => {});
      break;
    case "session":
      handleSessionSelect(target.sessionId);
      break;
    case "spa-route":
      // Top-level SPA route — push the URL directly and let vue-router
      // resolve the matching route + params (it knows `/collections/:slug?`,
      // `/automations/:taskId?`, etc.). This is what the bare push handles
      // generically; we don't need to map per-route param names.
      router.push(target.path).catch(() => {});
      break;
  }
}

function startNewChat(message: string, roleId?: string): void {
  // createNewSession sets currentSessionId synchronously (see the
  // comment on its declaration), so the follow-up sendMessage lands
  // in the new session rather than whatever was previously active.
  // Cross-route push behaviour (so browser Back returns to /wiki)
  // is now handled inside createNewSession via the isChatPage check.
  //
  // The id arrives from a plugin, and behind it possibly a sandboxed custom view.
  // Asking for nothing still inherits the selector's current pick, but an id this
  // refuses falls to General rather than to that pick — the more suspicious input
  // must not get the broader answer, and the draft path already answers General.
  createNewSession(roleId === undefined ? undefined : (resolveRequestedRoleId(roleId, roles.value) ?? BUILTIN_ROLE_IDS.general));
  void sendMessage(message);
  void seedCollectionPresentation(message);
}

// A chat started from a collection view carries that collection's slash command
// (`/<slug> …`). Present the collection in the canvas immediately — a
// client-side stand-in for the presentCollection call the agent makes when the
// message is sent — so the collection is visible up front (#1768). Used by both
// entry points: startNewChat (message sent) and startNewChatDraft (message left
// as an editable draft). The placeholder is reconciled away once the real tool
// result arrives (reconcileSyntheticCollection in eventDispatch). No-op for
// non-collection slash commands (e.g. /deep-research) and plain prose.
async function seedCollectionPresentation(message: string): Promise<void> {
  const seed = parseCollectionSlashSeed(message);
  if (!seed) return;
  const session = activeSession.value;
  if (!session) return;
  if (!(await isKnownCollectionSlug(seed.slug))) return;
  // The active session can change while the collection-list fetch is in flight
  // (user starts another chat); only seed the session we parsed for.
  if (activeSession.value?.id !== session.id) return;
  // Race guard: if the agent's real presentCollection result already arrived
  // (fast agent, slow collection-list fetch), reconcile has nothing to remove,
  // so seeding now would append a stale duplicate. Skip — the real card is up.
  if (hasRealCollectionResult(session, seed.slug)) return;
  applyToolResultToSession(session, makeSyntheticCollectionResult(seed.slug, seed.itemId));
}

// Confirm `slug` names a real collection before seeding — otherwise a
// non-collection slash command would flash a "not found" collection canvas. On
// fetch failure we skip the optimistic card; the agent still presents it.
async function isKnownCollectionSlug(slug: string): Promise<boolean> {
  const result = await apiGet<CollectionsListResponse>(API_ROUTES.collections.list);
  if (!result.ok) return false;
  return result.data.collections.some((collection) => collection.slug === slug);
}

// Like startNewChat, but prefills the composer with `message` as an editable
// DRAFT instead of sending it — the user reviews / edits / sends (or clears) it.
// Used by custom collection views (`__MC_VIEW.startChat`) so a view button can
// propose a chat without the view's code triggering an agent run on its own.
// `roleId` comes from a plugin and is honoured only when `roleSelection.ts`
// allows it; anything else opens in General (createNewSession does
// not validate the id it is handed). When the draft is a collection slash
// command, the collection is presented in the canvas up front (#1768) —
// presentCollection first, then the prefilled draft.
function startNewChatDraft(message: string, roleId?: string): void {
  const rId = resolveRequestedRoleId(roleId, roles.value) ?? BUILTIN_ROLE_IDS.general;
  createNewSession(rId);
  userInput.value = message;
  chatInputRef.value?.collapseSuggestions();
  nextTick(() => focusChatInput());
  void seedCollectionPresentation(message);
}

function handleAskGemini(): void {
  startNewChat(t("settingsModal.geminiAskMessage"), BUILTIN_ROLE_IDS.general);
}

// Plugin Views call back into App.vue via provide/inject (#227).
provideAppApi({
  refreshRoles,
  sendMessage: (message: string) => sendMessage(message),
  startNewChat: (message: string, roleId?: string) => startNewChat(message, roleId),
  navigateToWorkspacePath: (href: string) => navigateToWorkspacePath(href),
  getResultTimestamp: (uuid: string) => activeSession.value?.resultTimestamps.get(uuid),
});

// Wire the two collection-plugin UI capabilities that need a component context
// (the rest are configured at module load in composables/collections/uiHost.ts).
// `useNotifications()` needs onUnmounted + pubsub inject; `startNewChat` is
// App-owned. Done here so it's set before any CollectionView (a descendant) mounts.
const { entries: notifierEntries } = useNotifications();
installCollectionAppBindings({
  startChat: (prompt: string, role: string) => startNewChat(prompt, role),
  startNewChatDraft: (prompt: string, role?: string) => startNewChatDraft(prompt, role),
  notifiedSeverities: (slug: string) => collectionNotifiedSeverities(notifierEntries.value, slug),
});
// Keep pinned collection-launcher icons that declare `dynamicIcon` live —
// mounted here (not inside CollectionsIndexView) so it runs regardless of
// which page is open.
useDynamicShortcutIcons();
// Plugin Views that need to tag background work with the current
// session (e.g. MulmoScript generations) inject this.
provideActiveSession(activeSession);

useEventListeners({
  onKeyNavigation: handleKeyNavigation,
  onTeardown: () => {
    teardownPendingCalls();
    teardownRunElapsed();
  },
});

onMounted(async () => {
  // Fire-and-forget side fetches.
  fetchHealth();
  fetchMcpToolsStatus();
  // Awaited below before resuming the top session, so we know the
  // sessions list is populated when we pick which one to land on.
  const sessionsReady = fetchSessions();
  // Roles must be loaded before the first session is created, so
  // createNewSession() picks a roleId that exists in the merged
  // role list (built-in + custom).
  await refreshRoles();

  // Session bootstrap only applies on /chat. On /files, /wiki,
  // etc. we must not create or load a chat session — doing so would
  // replace the URL with /chat/<new-id> and pull the user off the page
  // they actually loaded.
  //
  // Read the URL's sessionId directly rather than through
  // currentSessionId.value — the route-param watcher isn't `immediate`,
  // so on a hard load of /chat/<id> the ref may still be "" when we
  // reach this code and we'd mistakenly resume the top session.
  if (route.name === PAGE_ROUTES.chat) {
    const urlSessionId = typeof route.params.sessionId === "string" ? route.params.sessionId : "";
    if (urlSessionId) {
      if (currentSessionId.value !== urlSessionId) {
        currentSessionId.value = urlSessionId;
      }
      await loadSession(urlSessionId);
      // loadSession is a no-op when the server returns 404 — in that
      // case sessionMap won't have the id, so fall through to create.
      if (!sessionMap.has(urlSessionId)) {
        createNewSession();
      }
    } else {
      await sessionsReady;
      await resumeOrCreateChatSession();
    }
  }
});
</script>
