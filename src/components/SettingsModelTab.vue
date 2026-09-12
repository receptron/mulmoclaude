<template>
  <div class="space-y-3" data-testid="settings-model-tab">
    <p class="text-sm text-gray-700">{{ t("settingsModal.modelTab.description") }}</p>

    <div class="space-y-2">
      <label class="block text-sm font-medium text-gray-800" for="settings-model-chat-model">{{ t("settingsModal.modelTab.modelLabel") }}</label>
      <select
        id="settings-model-chat-model"
        v-model="modelDraft"
        class="w-full px-3 py-2 text-sm rounded border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
        data-testid="settings-model-model-select"
        @change="save(modelField)"
      >
        <option value="">{{ t("settingsModal.modelTab.modelUnset") }}</option>
        <option v-for="model in CHAT_MODELS" :key="model" :value="model">{{ model }}</option>
      </select>
      <p class="text-xs text-gray-500">{{ t("settingsModal.modelTab.modelHelperText") }}</p>
    </div>

    <div class="space-y-2">
      <label class="block text-sm font-medium text-gray-800" for="settings-model-effort">{{ t("settingsModal.modelTab.effortLabel") }}</label>
      <select
        id="settings-model-effort"
        v-model="effortDraft"
        class="w-full px-3 py-2 text-sm rounded border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
        data-testid="settings-model-effort-select"
        @change="save(effortField)"
      >
        <option value="">{{ t("settingsModal.modelTab.effortUnset") }}</option>
        <option v-for="level in EFFORT_LEVELS" :key="level" :value="level">{{ level }}</option>
      </select>
      <p class="text-xs text-gray-500">{{ t("settingsModal.modelTab.helperText") }}</p>
    </div>

    <div v-if="loaded && !errorMessage" class="flex items-center gap-3 text-xs">
      <span :class="colourOf(modelField)" data-testid="settings-model-model-status">
        {{ modelStatusText }}
      </span>
      <span :class="colourOf(effortField)" data-testid="settings-model-status">
        {{ statusText }}
      </span>
    </div>

    <p v-if="errorMessage" class="text-sm text-red-700" role="alert" data-testid="settings-model-error">{{ errorMessage }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { apiGet, apiPut } from "../utils/api";
import { API_ROUTES } from "../config/apiRoutes";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

// Family aliases only — mirrors CHAT_MODELS in server/system/config.ts,
// which is what the PUT validator accepts (#2923).
const CHAT_MODELS = ["opus", "sonnet", "haiku"] as const;
type ChatModel = (typeof CHAT_MODELS)[number];

const { t } = useI18n();

const props = defineProps<{
  reloadToken: number;
}>();

const emit = defineEmits<{
  saved: [];
}>();

interface SettingsResponse {
  settings: { extraAllowedTools: string[]; effortLevel?: EffortLevel; chatModel?: ChatModel };
}

// One select's whole state, so the save dance below is written once
// rather than per field. `""` is the "not set" option, which the PUT
// carries as the `null` clear-me sentinel.
interface SettingField<T extends string> {
  key: "effortLevel" | "chatModel";
  draft: Ref<T | "">;
  stored: Ref<T | "">;
  saving: Ref<boolean>;
}

const effortDraft = ref<EffortLevel | "">("");
const storedEffort = ref<EffortLevel | "">("");
const savingEffort = ref(false);
const effortField: SettingField<EffortLevel> = { key: "effortLevel", draft: effortDraft, stored: storedEffort, saving: savingEffort };

const modelDraft = ref<ChatModel | "">("");
const storedModel = ref<ChatModel | "">("");
const savingModel = ref(false);
const modelField: SettingField<ChatModel> = { key: "chatModel", draft: modelDraft, stored: storedModel, saving: savingModel };

const loaded = ref(false);
const errorMessage = ref("");

// statusText / colourOf are only consumed when there is no
// errorMessage (the template hides the strip in that case), so the
// error branches don't need to be repeated here.
const statusText = computed(() => {
  if (savingEffort.value) return t("common.saving");
  return storedEffort.value ? t("settingsModal.modelTab.configured", { level: storedEffort.value }) : t("settingsModal.modelTab.notConfigured");
});

const modelStatusText = computed(() => {
  if (savingModel.value) return t("common.saving");
  return storedModel.value ? t("settingsModal.modelTab.modelConfigured", { model: storedModel.value }) : t("settingsModal.modelTab.modelNotConfigured");
});

function colourOf<T extends string>(field: SettingField<T>): string {
  if (field.saving.value) return "text-gray-500";
  return field.stored.value ? "text-green-600" : "text-gray-500";
}

async function load(): Promise<void> {
  errorMessage.value = "";
  const response = await apiGet<SettingsResponse>(API_ROUTES.config.base);
  if (!response.ok) {
    errorMessage.value = response.error || t("settingsModal.modelTab.loadError");
    return;
  }
  storedEffort.value = response.data.settings.effortLevel ?? "";
  effortDraft.value = storedEffort.value;
  storedModel.value = response.data.settings.chatModel ?? "";
  modelDraft.value = storedModel.value;
  loaded.value = true;
}

async function save<T extends string>(field: SettingField<T>): Promise<void> {
  if (field.saving.value) return;
  if (field.draft.value === field.stored.value) return;
  // Capture the submitted value before awaiting — if the user changes
  // the select again while this PUT is in flight, the second save()
  // would early-return on `saving=true`, and a naive
  // `stored = draft` assignment after await would store the newer
  // (unsaved) draft, masking later saves (codex review).
  const requested = field.draft.value;
  field.saving.value = true;
  errorMessage.value = "";
  // Empty selection clears the field. The server merges patches over
  // on-disk state, so omitting the key keeps the previous value — we
  // must send `null` to clear. Only this field travels, so the other
  // select's value is never echoed back and cannot be clobbered.
  const response = await apiPut<unknown>(API_ROUTES.config.settings, { [field.key]: requested === "" ? null : requested });
  field.saving.value = false;
  if (!response.ok) {
    errorMessage.value = response.error || t("settingsModal.modelTab.saveError");
    return;
  }
  field.stored.value = requested;
  emit("saved");
  // If the draft moved while we were in flight, re-trigger save so
  // the latest value reaches the server.
  if (field.draft.value !== requested) {
    void save(field);
  }
}

watch(
  () => props.reloadToken,
  () => {
    void load();
  },
  { immediate: true },
);
</script>
