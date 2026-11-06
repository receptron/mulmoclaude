<template>
  <div v-if="open" class="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-16" data-testid="settings-modal-backdrop" @click="close">
    <div
      class="bg-white rounded-lg shadow-xl w-[clamp(64rem,88vw,90rem)] max-w-[95vw] max-h-[85vh] flex flex-col"
      :class="{ 'h-[85vh]': isFullTab }"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      data-testid="settings-modal"
      @click.stop
    >
      <div class="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h2 id="settings-modal-title" class="text-base font-semibold text-gray-900">{{ t("settingsModal.title") }}</h2>
          <p v-if="appVersion" class="text-xs text-gray-600 mt-0.5" data-testid="settings-app-version">
            {{ t("settingsModal.version", { version: appVersion }) }}
          </p>
        </div>
        <button class="text-gray-400 hover:text-gray-700" :title="t('common.close')" data-testid="settings-close-btn" @click="close">
          <span class="material-icons">close</span>
        </button>
      </div>

      <div class="flex flex-1 min-h-0">
        <nav class="w-44 border-r border-gray-200 bg-gray-50 py-3 overflow-y-auto" :aria-label="t('settingsModal.navAriaLabel')" data-testid="settings-nav">
          <div v-for="group in visibleGroups" :key="group.key" class="mb-3">
            <div class="px-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              {{ t(`settingsModal.groups.${group.key}`) }}
            </div>
            <button
              v-for="tabId in group.items"
              :key="tabId"
              class="w-full text-left px-4 py-1.5 text-sm border-l-2"
              :class="activeTab === tabId ? 'border-blue-500 bg-white text-blue-700 font-medium' : 'border-transparent text-gray-700 hover:bg-gray-100'"
              :data-testid="`settings-tab-${tabId}`"
              :aria-current="activeTab === tabId ? 'page' : undefined"
              @click="activeTab = tabId"
            >
              {{ t(`settingsModal.tabs.${tabId}`) }}
            </button>
          </div>
        </nav>

        <!-- Form tabs cap their own width: the modal is sized for the
             skill / role editors, and single-column inputs stretched to
             that width are hard to read. -->
        <div :class="isFullTab ? 'flex-1 min-h-0 overflow-hidden text-gray-900' : 'px-5 py-4 overflow-y-auto flex-1 max-w-[52rem] space-y-4 text-gray-900'">
          <!-- Full management surfaces (relocated from the top-bar
               launcher). Each ships its own header / scrolling / save,
               so they render full-bleed. SkillsView calls useRuntime()
               and must be wrapped in PluginScopedRoot; RolesView talks
               to /api/roles directly and needs no wrapper. -->
          <PluginScopedRoot v-if="activeTab === 'skills'" pkg-name="skills" :endpoints="API_ROUTES.skills">
            <SkillsView />
          </PluginScopedRoot>
          <RolesView v-else-if="activeTab === 'roles'" />

          <!-- Form-style config tabs -->
          <template v-else>
            <div v-if="loadError" class="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2" role="alert" data-testid="settings-load-error">
              ⚠ {{ loadError }}
            </div>

            <SettingsGeminiTab
              v-if="activeTab === 'gemini'"
              :reload-token="geminiReloadToken"
              :gemini-available="geminiAvailable"
              :env-file-path="envFileLabel"
              @saved="emit('saved')"
              @ask="askAboutGemini"
            />

            <div v-else-if="activeTab === 'tools'" class="space-y-3">
              <i18n-t keypath="settingsToolsTab.explanation" tag="p" class="text-xs text-gray-600 leading-relaxed">
                <template #allowedTools><code class="bg-gray-100 px-1 rounded">--allowedTools</code></template>
                <template #claudeMcp><code class="bg-gray-100 px-1 rounded">claude mcp</code></template>
              </i18n-t>
              <label class="block">
                <span class="text-xs font-semibold text-gray-700">{{ t("settingsModal.toolNamesLabel") }}</span>
                <textarea
                  v-model="toolsText"
                  class="mt-1 w-full h-48 px-2 py-1.5 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:border-blue-400"
                  placeholder="mcp__claude_ai_Gmail&#10;mcp__claude_ai_Google_Calendar"
                  data-testid="settings-tools-textarea"
                  @keydown.stop
                ></textarea>
              </label>
              <p v-if="invalidToolNames.length > 0" class="text-xs text-amber-700">
                {{ t("settingsModal.invalidToolNamesPrefix") }}
                <code class="bg-gray-100 px-1 rounded">mcp__</code>{{ t("settingsModal.invalidToolNamesSuffix") }}
                {{ invalidToolNames.join(", ") }}
              </p>
              <div class="flex items-center gap-2">
                <button
                  class="px-3 py-1.5 text-sm rounded bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
                  :disabled="toolsSaving || loading || !!loadError || !toolsDirty"
                  :title="loadError ? t('settingsModal.cannotSaveTooltip') : undefined"
                  data-testid="settings-tools-save-btn"
                  @click="saveTools"
                >
                  {{ toolsSaving ? t("settingsModal.saving") : t("common.save") }}
                </button>
                <span v-if="toolsDirty" class="text-xs text-amber-600" data-testid="settings-tools-dirty">
                  {{ t("settingsModal.unsavedMarker") }}
                </span>
              </div>

              <div class="space-y-1.5 pt-2 border-t border-gray-200" data-testid="settings-connectors">
                <span class="text-xs font-semibold text-gray-700">{{ t("settingsToolsTab.connectorsSectionTitle") }}</span>
                <div v-if="connectorsLoading" class="text-xs text-gray-400">{{ t("common.loading") }}</div>
                <ul v-else-if="connectors.length > 0" class="text-xs text-gray-700 space-y-0.5">
                  <li
                    v-for="c in connectors"
                    :key="c.name"
                    class="flex items-center gap-1.5"
                    :aria-label="`${c.name} — ${c.connected ? t('settingsToolsTab.connectorConnected') : t('settingsToolsTab.connectorDisconnected')}`"
                  >
                    <span class="material-icons text-[14px]" :class="c.connected ? 'text-green-600' : 'text-gray-400'" aria-hidden="true">
                      {{ c.connected ? "check_circle" : "radio_button_unchecked" }}
                    </span>
                    {{ c.name }}
                  </li>
                </ul>
                <div v-else class="text-xs text-gray-400">{{ t("settingsToolsTab.connectorsEmpty") }}</div>
                <i18n-t keypath="settingsToolsTab.connectorsGuide" tag="p" class="text-xs text-gray-500">
                  <template #configLink>
                    <a href="https://claude.ai/customize/connectors" target="_blank" rel="noopener noreferrer" class="text-blue-500 underline">{{
                      t("settingsToolsTab.connectorsConfigLinkText")
                    }}</a>
                  </template>
                </i18n-t>
              </div>
            </div>

            <div v-else-if="activeTab === 'mcp'" class="space-y-3">
              <div
                v-if="mcpToolsError"
                class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1"
                role="alert"
                data-testid="mcp-tools-error"
              >
                {{ t("settingsModal.mcpToolsError", { error: mcpToolsError }) }}
              </div>
              <SettingsMcpTab
                ref="mcpTabRef"
                :servers="mcpServers"
                :docker-mode="dockerMode"
                @add="addMcpServer"
                @update="updateMcpServer"
                @remove="removeMcpServer"
              />
            </div>

            <SettingsWorkspaceDirsTab v-else-if="activeTab === 'dirs'" />

            <SettingsReferenceDirsTab v-else-if="activeTab === 'refs'" />

            <SettingsMapTab v-else-if="activeTab === 'map'" :reload-token="mapReloadToken" @saved="onMapSaved" />

            <SettingsPhotosTab v-else-if="activeTab === 'photos'" :reload-token="photosReloadToken" />

            <SettingsGoogleTab v-else-if="activeTab === 'google'" :reload-token="googleReloadToken" />

            <SettingsModelTab v-else-if="activeTab === 'model'" :reload-token="modelReloadToken" @saved="emit('saved')" />

            <SettingsVoiceTab v-else-if="activeTab === 'voice'" :reload-token="voiceReloadToken" />

            <SettingsChatIndexTab v-else-if="activeTab === 'chatIndex'" :reload-token="chatIndexReloadToken" @saved="emit('saved')" />

            <SettingsJournalTab v-else-if="activeTab === 'journal'" :reload-token="journalReloadToken" @saved="emit('saved')" />

            <SettingsNotificationsTab v-else-if="activeTab === 'notifications'" :reload-token="notificationsReloadToken" @saved="emit('saved')" />
            <!-- Its own `v-if`, not part of the chain above: the chain is
                 long and every entry added to it has to stay adjacent to
                 survive the compiler. This tab is mutually exclusive with
                 the rest by construction, so it does not need to be in it. -->
            <SettingsQuitTab v-if="activeTab === 'quit'" @stopped="emit('stopped')" />
            <SettingsClientTokensTab v-if="activeTab === 'clientTokens'" />
          </template>
        </div>
      </div>

      <!-- Footer: status strip only. MCP / Workspace Dirs / Reference
           Dirs auto-save; Allowed Tools has its own Save button inside
           the tab body. So no global Save/Cancel — close the modal
           via the ✕ button in the header (which prompts on unsaved
           tools edits or a pending MCP draft). Hidden on the gemini
           tab since it has no settings to save. -->
      <div v-if="activeTab !== 'gemini' && !isFullTab" class="px-5 py-3 border-t border-gray-200 min-h-[2.75rem] flex items-center gap-3">
        <span v-if="statusMessage" class="text-xs" :class="statusError ? 'text-red-600' : 'text-green-600'" data-testid="settings-status">
          {{ statusMessage }}
        </span>
        <span v-else class="text-xs text-gray-500"> {{ t("settingsModal.changesHint") }} </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import SettingsMcpTab from "./SettingsMcpTab.vue";
import SettingsWorkspaceDirsTab from "./SettingsWorkspaceDirsTab.vue";
import SettingsReferenceDirsTab from "./SettingsReferenceDirsTab.vue";
import SettingsGeminiTab from "./SettingsGeminiTab.vue";
import SettingsMapTab from "./SettingsMapTab.vue";
import SettingsPhotosTab from "./SettingsPhotosTab.vue";
import SettingsGoogleTab from "./SettingsGoogleTab.vue";
import SettingsModelTab from "./SettingsModelTab.vue";
import SettingsVoiceTab from "./SettingsVoiceTab.vue";
import SettingsChatIndexTab from "./SettingsChatIndexTab.vue";
import SettingsJournalTab from "./SettingsJournalTab.vue";
import SettingsNotificationsTab from "./SettingsNotificationsTab.vue";
import SettingsQuitTab from "./SettingsQuitTab.vue";
import SettingsClientTokensTab from "./SettingsClientTokensTab.vue";
import SkillsView from "../plugins/manageSkills/View.vue";
import RolesView from "./RolesView.vue";
import PluginScopedRoot from "./PluginScopedRoot.vue";
import type { McpServerEntry } from "./SettingsMcpTab.vue";
import { apiGet, apiPut } from "../utils/api";
import { API_ROUTES } from "../config/apiRoutes";

const { t } = useI18n();

// Settings save model — per #716 follow-up.
//
// Only Allowed Tools needs a Save button: the textarea accumulates
// free-form edits that can't be auto-persisted on every keystroke.
// Every other tab (MCP, Workspace Dirs, Reference Dirs) is append/
// remove only, so each mutation persists through its own endpoint
// the moment it happens. Closing the modal just closes — no global
// Save/Cancel buttons.
//
// If the user closes with unsaved Tools edits, a confirm dialog
// asks whether to discard.

interface Props {
  open: boolean;
  dockerMode?: boolean;
  geminiAvailable?: boolean;
  // Absolute path of the `.env` this launch reads, from `/api/health`.
  // Named rather than described because the two launch routes do not read
  // the same file and an icon launch has no launch directory to point at
  // (#2626). Empty before the first health response — the text then falls
  // back to the bare filename it always showed.
  geminiEnvFilePath?: string;
  // Forwarded from useMcpTools — if non-null, the MCP tab shows a
  // small warning strip so the user knows "all tools visible" is a
  // fallback rather than an accurate listing.
  mcpToolsError?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
  dockerMode: false,
  geminiAvailable: true,
  geminiEnvFilePath: "",
  mcpToolsError: null,
});
const emit = defineEmits<{
  "update:open": [value: boolean];
  saved: [];
  "ask-gemini": [];
  stopped: [];
}>();

// Typed ref to the SettingsMcpTab. Needed so close() can check
// whether the user has a pending draft MCP entry open — that's the
// one remaining \"unsaved\" state on the MCP tab (individual add /
// update / remove persist immediately).
const mcpTabRef = ref<{ flushDraft: () => boolean; hasPendingDraft: () => boolean } | null>(null);

type TabId =
  | "gemini"
  | "tools"
  | "mcp"
  | "dirs"
  | "refs"
  | "map"
  | "photos"
  | "google"
  | "model"
  | "voice"
  | "chatIndex"
  | "journal"
  | "notifications"
  | "skills"
  | "roles"
  | "clientTokens"
  | "quit";

const activeTab = ref<TabId>("tools");

// "Full" tabs host an entire management surface (Skills / Roles) that
// ships its own header, scrolling, and auto-save. They render full-bleed
// (no body padding) and widen the dialog for the Skills two-pane layout,
// unlike the form-style config tabs above.
const FULL_TABS: readonly TabId[] = ["skills", "roles"];
const isFullTab = computed(() => FULL_TABS.includes(activeTab.value));

// Sidebar nav layout (#1333). Order within each group reflects expected
// access frequency; order of groups reflects the same. Every item is
// always listed: `gemini` used to be hidden once a key was present, which
// stopped making sense when the tab became the place the key is typed
// (#871) — a configured key is exactly what you open it to replace.
const GROUPS: readonly { key: string; items: readonly TabId[] }[] = [
  { key: "llm", items: ["model", "voice", "chatIndex", "journal", "tools", "gemini"] },
  { key: "servers", items: ["mcp"] },
  { key: "workspace", items: ["dirs", "refs"] },
  { key: "notifications", items: ["notifications"] },
  { key: "plugins", items: ["map", "photos", "google"] },
  // Management surfaces relocated from the top-bar launcher (#skills /
  // #roles). Both are static configuration, not dynamic workspace data.
  { key: "management", items: ["skills", "roles"] },
  // Last on purpose: stopping the server is a deliberate act, not
  // something to sit a mis-click away from the controls above (#2616).
  { key: "server", items: ["clientTokens", "quit"] },
];

// The file to name in the Gemini tab. The bare filename is the fallback
// for the window before the first health response, not a second option:
// which directory it sits in is the whole question on an icon launch.
const ENV_FILE_NAME = ".env";
const envFileLabel = computed(() => props.geminiEnvFilePath || ENV_FILE_NAME);

const visibleGroups = computed(() => GROUPS.filter((group) => group.items.length > 0));

// Forces SettingsMapTab to re-load when the modal opens or the user
// confirms a save — ensures the input always reflects the latest
// on-disk state. Increment is the cheap signal; the child watches
// `reloadToken` and refetches.
const mapReloadToken = ref(0);
function onMapSaved(): void {
  // Bump the token so any other Map-key consumer (e.g. App.vue) can
  // also notice via the `saved` event bubble.
  emit("saved");
}

// Same pattern as mapReloadToken — bumped when the modal opens so
// the Photos tab refetches the autoCapture flag (could have been
// hand-edited in settings.json since the last visit).
const photosReloadToken = ref(0);
const googleReloadToken = ref(0);
const modelReloadToken = ref(0);
const voiceReloadToken = ref(0);
const chatIndexReloadToken = ref(0);
const journalReloadToken = ref(0);
const notificationsReloadToken = ref(0);
const geminiReloadToken = ref(0);
const toolsText = ref("");
// Server truth for tools — updated on load and on a successful Save
// from the Tools tab. `toolsDirty` compares this against `toolsText`
// so the close-with-unsaved confirm only fires when the user has
// actually edited the list.
const toolsSavedText = ref("");
const mcpServers = ref<McpServerEntry[]>([]);
const connectors = ref<{ name: string; connected: boolean }[]>([]);
const connectorsLoading = ref(false);
const loadError = ref("");
// App version (root package.json), surfaced from /api/health. Fetched
// once on first open and kept — it can't change mid-process.
const appVersion = ref("");
const statusMessage = ref("");
const statusError = ref(false);
const toolsSaving = ref(false);
// `true` from the moment the modal opens until the first loadConfig()
// call resolves. Prevents a user Save from submitting the initial
// empty arrays before the real config arrives, and prevents stale
// responses (from a previous open) from overwriting fresh input.
const loading = ref(false);
// Monotonically increasing token so an in-flight loadConfig() whose
// modal has been reopened can notice it's stale and discard its result.
let loadToken = 0;

const parsedToolNames = computed(() =>
  toolsText.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0),
);

// `toolsSavedText` is stored in normalized form (trimmed, blank lines
// dropped, joined with "\n"). Comparing the raw textarea against it
// would flag blank/trailing whitespace as "dirty" forever, so compare
// the normalized parse instead — the close-confirm then only fires
// when the effective tool list actually differs from the server's.
const toolsDirty = computed(() => parsedToolNames.value.join("\n") !== toolsSavedText.value);

const invalidToolNames = computed(() => parsedToolNames.value.filter((name) => !name.startsWith("mcp__") && !isBuiltIn(name)));

function isBuiltIn(name: string): boolean {
  return ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"].includes(name);
}

async function loadVersion(): Promise<void> {
  if (appVersion.value) return;
  // apiGet absorbs network + HTTP errors into `{ ok: false }` (see
  // ApiResult contract in utils/api.ts — it never throws), so a
  // try/catch would be unreachable. Both failure modes (network and
  // !ok) are handled the same way on purpose: the version line is
  // best-effort chrome, so on any failure we just leave it hidden.
  const response = await apiGet<{ version?: string }>(API_ROUTES.health);
  if (!response.ok || typeof response.data.version !== "string") return;
  appVersion.value = response.data.version;
}

async function loadConfig(): Promise<void> {
  const token = ++loadToken;
  loading.value = true;
  loadError.value = "";
  statusMessage.value = "";
  const response = await apiGet<{
    settings: { extraAllowedTools: string[] };
    mcp?: { servers: McpServerEntry[] };
  }>(API_ROUTES.config.base);
  // A newer open() has already started another load — drop this one.
  // eslint-disable-next-line security/detect-possible-timing-attacks -- in-memory race-token guard, not an auth compare
  if (token !== loadToken) return;
  if (!response.ok) {
    loadError.value = response.status === 0 ? response.error || "Network error" : `Failed to load settings (HTTP ${response.status})`;
  } else {
    const text = response.data.settings.extraAllowedTools.join("\n");
    toolsText.value = text;
    toolsSavedText.value = text;
    mcpServers.value = response.data.mcp?.servers ?? [];
  }
  // eslint-disable-next-line security/detect-possible-timing-attacks -- same race-token guard as above
  if (token === loadToken) loading.value = false;
}

let connectorLoadToken = 0;

async function loadConnectors(): Promise<void> {
  const token = ++connectorLoadToken;
  connectorsLoading.value = true;
  const response = await apiGet<{ connectors: { name: string; connected: boolean }[] }>(API_ROUTES.config.connectors);
  // eslint-disable-next-line security/detect-possible-timing-attacks -- in-memory race-token guard, not an auth compare
  if (token !== connectorLoadToken) return;
  if (response.ok) {
    connectors.value = response.data.connectors;
  }
  connectorsLoading.value = false;
}

// Tools tab — Save button hits the settings-only endpoint. MCP
// state is untouched by this path, so an unsaved MCP draft can't
// piggyback on a Tools save.
async function saveTools(): Promise<void> {
  if (loading.value) return;
  toolsSaving.value = true;
  statusMessage.value = "";
  statusError.value = false;
  const response = await apiPut<unknown>(API_ROUTES.config.settings, {
    extraAllowedTools: parsedToolNames.value,
  });
  if (!response.ok) {
    statusError.value = true;
    statusMessage.value = response.error || "Save failed";
  } else {
    toolsSavedText.value = parsedToolNames.value.join("\n");
    emit("saved");
    statusError.value = false;
    statusMessage.value = t("common.saved");
    setTimeout(() => {
      if (statusMessage.value === t("common.saved")) statusMessage.value = "";
    }, 2000);
  }
  toolsSaving.value = false;
}

// MCP mutations — each add/update/remove persists to the mcp-only
// endpoint. We serialize via an inflight chain but deliberately do
// NOT apply optimistic updates: a server-side rejection (e.g. a
// malformed server spec) would otherwise leave the invalid entry in
// local state and cascade-corrupt subsequent PUTs. Instead, each
// queued task derives its payload from the current (last
// server-confirmed) `mcpServers.value` at execute time, so prior
// successful mutations are incorporated but prior failures never
// poison later operations. Reset on modal open so a pending PUT
// from a previous session can't tail the new one.
let mcpInflight: Promise<unknown> = Promise.resolve();

type McpProducer = (current: McpServerEntry[]) => McpServerEntry[];

async function persistMcp(produce: McpProducer): Promise<void> {
  const task = mcpInflight
    .catch(() => undefined)
    .then(async () => {
      const next = produce(mcpServers.value);
      const response = await apiPut<{ servers: McpServerEntry[] }>(API_ROUTES.config.mcp, { servers: next });
      if (!response.ok) {
        statusError.value = true;
        statusMessage.value = response.error || t("settingsModal.mcpSaveFailed");
        return;
      }
      mcpServers.value = response.data?.servers ?? next;
      emit("saved");
      statusError.value = false;
      statusMessage.value = "";
    });
  mcpInflight = task;
  return task;
}

function askAboutGemini(): void {
  emit("ask-gemini");
  close();
}

function addMcpServer(entry: McpServerEntry): void {
  void persistMcp((current) => [...current, entry]);
}

function updateMcpServer(index: number, entry: McpServerEntry): void {
  // Capture identity so the update lands on the same logical row
  // even if earlier queued mutations shift indices.
  const target = mcpServers.value[index];
  void persistMcp((current) => current.map((srv) => (srv === target ? entry : srv)));
}

function removeMcpServer(index: number): void {
  const target = mcpServers.value[index];
  if (!target) return;
  void persistMcp((current) => current.filter((srv) => srv !== target));
}

function close(): void {
  // Guard against silent data loss. The draft forms and dirty text
  // belong to different tabs; warn about each so the user knows
  // which is at risk. window.confirm is the only blocking primitive
  // we have — copy is localized so non-English users get a
  // translated prompt.
  if (toolsDirty.value) {
    if (!window.confirm(t("settingsModal.unsavedToolsConfirm"))) return;
  }
  if (mcpTabRef.value?.hasPendingDraft()) {
    if (!window.confirm(t("settingsModal.unsavedMcpDraftConfirm"))) return;
  }
  emit("update:open", false);
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      // Reset async state from any previous session so a pending
      // PUT from a prior open can't tail newly queued mutations.
      mcpInflight = Promise.resolve();
      activeTab.value = props.geminiAvailable ? "tools" : "gemini";
      loadConfig();
      loadVersion();
      loadConnectors();
      mapReloadToken.value += 1;
      photosReloadToken.value += 1;
      googleReloadToken.value += 1;
      modelReloadToken.value += 1;
      voiceReloadToken.value += 1;
      chatIndexReloadToken.value += 1;
      journalReloadToken.value += 1;
      notificationsReloadToken.value += 1;
      geminiReloadToken.value += 1;
      statusMessage.value = "";
      statusError.value = false;
    }
  },
  { immediate: true },
);

// `geminiAvailable` can flip while the modal is already open — the
// `/api/health` poll in `useHealth` recovers from a transient failure
// asynchronously, and saving a key here makes it flip on purpose.
//
// It no longer moves the user OFF the gemini tab when a key appears: the
// tab is where the key is entered (#871), so a save would otherwise yank
// the user away from the thing they just did. Only the inverse remains —
// the key going away while the modal sits on the default landing tab.
watch(
  () => props.geminiAvailable,
  (available) => {
    if (!props.open) return;
    if (!available && activeTab.value === "tools") {
      // Only bounce to the warning tab if the user hasn't navigated
      // away from the default landing tab. Respecting an explicit
      // pick on dirs / mcp / refs avoids yanking them mid-edit.
      activeTab.value = "gemini";
    }
  },
);
</script>
