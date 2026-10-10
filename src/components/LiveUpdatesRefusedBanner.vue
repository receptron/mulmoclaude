<template>
  <div
    v-if="liveUpdatesRefused"
    data-testid="live-updates-refused-banner"
    role="alert"
    class="flex items-center gap-2 px-3 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-sm"
  >
    <span class="material-icons text-base" aria-hidden="true">sync_disabled</span>
    <div class="flex-1 min-w-0">
      <div class="font-medium">{{ t("liveUpdatesRefused.title") }}</div>
      <div class="text-xs text-amber-700 truncate">{{ t("liveUpdatesRefused.body") }}</div>
    </div>
    <button
      type="button"
      data-testid="live-updates-refused-reload"
      class="h-8 px-2.5 flex items-center gap-1 text-sm rounded border border-amber-300 text-amber-800 hover:bg-amber-100"
      @click="reload"
    >
      <span class="material-icons text-sm" aria-hidden="true">refresh</span>
      {{ t("liveUpdatesRefused.reload") }}
    </button>
  </div>
</template>

<script setup lang="ts">
// Shown when the server refused the pub/sub handshake (#3433). The token is
// regenerated at every server start, so this is what a restart looks like from
// a page that stayed open; socket.io does not retry a refusal, and a reload is
// the only way to fetch the new token (index.html carries it).
import { useI18n } from "vue-i18n";
import { liveUpdatesRefused } from "../composables/usePubSub";

const { t } = useI18n();

const reload = (): void => window.location.reload();
</script>
