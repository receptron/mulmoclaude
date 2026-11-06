<template>
  <div class="space-y-3" data-testid="settings-client-tokens-tab">
    <p class="text-sm text-gray-700">{{ t("settingsModal.clientTokensTab.description") }}</p>
    <p class="text-xs text-gray-500">
      {{ t("settingsModal.clientTokensTab.issueHint") }}
      <code class="rounded bg-gray-100 px-1 py-0.5 font-mono text-gray-800">{{ t("settingsModal.clientTokensTab.issueCommand") }}</code>
    </p>

    <p v-if="loading" class="text-sm text-gray-500" data-testid="settings-client-tokens-loading">{{ t("settingsModal.clientTokensTab.loading") }}</p>
    <p v-else-if="tokens.length === 0 && !loadError" class="text-sm text-gray-500" data-testid="settings-client-tokens-empty">
      {{ t("settingsModal.clientTokensTab.empty") }}
    </p>

    <table v-else-if="tokens.length > 0" class="w-full text-sm" data-testid="settings-client-tokens-list">
      <thead>
        <tr class="text-left text-xs text-gray-500 border-b border-gray-200">
          <th class="py-1 pr-3 font-medium">{{ t("settingsModal.clientTokensTab.columnName") }}</th>
          <th class="py-1 pr-3 font-medium">{{ t("settingsModal.clientTokensTab.columnScopes") }}</th>
          <th class="py-1 pr-3 font-medium">{{ t("settingsModal.clientTokensTab.columnCreated") }}</th>
          <th class="py-1 pr-3 font-medium">{{ t("settingsModal.clientTokensTab.columnLastUsed") }}</th>
          <th class="py-1" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="token in tokens" :key="token.id" class="border-b border-gray-100 align-top" :data-testid="`settings-client-token-${token.name}`">
          <td class="py-1.5 pr-3 font-mono text-gray-900">{{ token.name }}</td>
          <td class="py-1.5 pr-3 font-mono text-xs text-gray-700">{{ token.scopes.join(", ") }}</td>
          <td class="py-1.5 pr-3 text-xs text-gray-700">{{ formatIso(token.createdAt) }}</td>
          <td class="py-1.5 pr-3 text-xs text-gray-700" data-testid="settings-client-token-last-used">
            {{ token.lastUsedAt === null ? t("settingsModal.clientTokensTab.neverUsed") : formatIso(token.lastUsedAt) }}
          </td>
          <td class="py-1.5 text-right">
            <div v-if="confirmingName === token.name" class="flex justify-end gap-2">
              <button
                type="button"
                class="rounded bg-red-700 px-2 py-1 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50"
                :disabled="revokingName !== null"
                data-testid="settings-client-token-confirm-btn"
                @click="revoke(token.name)"
              >
                {{ revokingName === token.name ? t("settingsModal.clientTokensTab.revoking") : t("settingsModal.clientTokensTab.confirmLabel") }}
              </button>
              <button
                type="button"
                class="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                :disabled="revokingName !== null"
                data-testid="settings-client-token-cancel-btn"
                @click="confirmingName = null"
              >
                {{ t("common.cancel") }}
              </button>
            </div>
            <button
              v-else
              type="button"
              class="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
              :disabled="revokingName !== null"
              data-testid="settings-client-token-revoke-btn"
              @click="confirmingName = token.name"
            >
              {{ t("settingsModal.clientTokensTab.revokeLabel") }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-if="confirmingName !== null" class="text-xs text-red-900" data-testid="settings-client-token-confirm-body">
      {{ t("settingsModal.clientTokensTab.confirmBody", { name: confirmingName }) }}
    </p>
    <p class="text-xs text-gray-500">{{ t("settingsModal.clientTokensTab.lastUsedNote") }}</p>
    <p v-if="loadError" class="text-sm text-red-700" role="alert" data-testid="settings-client-tokens-error">{{ loadError }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { apiDelete, apiGet } from "../utils/api";
import { API_ROUTES } from "../config/apiRoutes";
import { formatDateTime } from "../utils/format/date";

interface ClientTokenRow {
  name: string;
  id: string;
  createdAt: string;
  scopes: string[];
  lastUsedAt: string | null;
}

const { t } = useI18n();

const tokens = ref<ClientTokenRow[]>([]);
const loading = ref(true);
const loadError = ref("");
const confirmingName = ref<string | null>(null);
const revokingName = ref<string | null>(null);

function formatIso(iso: string): string {
  const epochMs = Date.parse(iso);
  return Number.isNaN(epochMs) ? iso : formatDateTime(epochMs);
}

async function load(): Promise<void> {
  const response = await apiGet<{ tokens: ClientTokenRow[] }>(API_ROUTES.config.clientTokens);
  loading.value = false;
  if (!response.ok) {
    loadError.value = response.error || t("settingsModal.clientTokensTab.loadError");
    return;
  }
  loadError.value = "";
  tokens.value = response.data.tokens;
}

async function revoke(name: string): Promise<void> {
  if (revokingName.value !== null) return;
  revokingName.value = name;
  const response = await apiDelete<{ revoked: string }>(API_ROUTES.config.clientToken.replace(":name", encodeURIComponent(name)));
  revokingName.value = null;
  confirmingName.value = null;
  if (!response.ok) {
    loadError.value = response.error || t("settingsModal.clientTokensTab.revokeError");
    return;
  }
  await load();
}

onMounted(load);
</script>
