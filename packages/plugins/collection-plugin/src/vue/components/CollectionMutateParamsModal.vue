<template>
  <!-- Mini-form for a `kind: "mutate"` action's declared `params`,
       rendered inside the shared record-modal shell (focus trap,
       Escape/backdrop close). Deliberately tiny: the specs reuse the
       table sub-field DSL, so a handful of input kinds covers them all;
       the server re-validates every value with the shared record checks
       and its `problem` text renders inline here on rejection. -->
  <CollectionRecordModal @close="emit('close')">
    <form class="flex flex-col overflow-y-auto" data-testid="collections-mutate-modal" @submit.prevent="submit">
      <div class="flex items-center justify-between px-6 pt-5 pb-3">
        <h2 class="text-sm font-bold text-slate-800 flex items-center gap-1.5">
          <span v-if="action.icon" class="text-indigo-600"><IconGlyph :icon="action.icon" size-class="text-base" /></span>
          <span>{{ action.label }}</span>
        </h2>
        <button
          type="button"
          class="h-8 w-8 flex items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          :aria-label="t('common.close')"
          data-testid="collections-mutate-close"
          @click="emit('close')"
        >
          <span class="material-icons text-lg">close</span>
        </button>
      </div>

      <div class="flex flex-col gap-4 px-6 pb-2">
        <div v-for="(spec, key) in action.params" :key="key" class="flex flex-col gap-1.5">
          <label class="text-[10px] font-bold text-slate-400 uppercase tracking-wider" :for="`collections-mutate-${key}`">
            {{ spec.label }}
            <!-- eslint-disable-next-line @intlify/vue-i18n/no-raw-text -- bare "*" required glyph, same treatment as the record form. -->
            <span v-if="spec.required" class="text-rose-500 font-bold">*</span>
          </label>

          <label v-if="spec.type === 'boolean'" class="inline-flex items-center gap-2.5 cursor-pointer select-none">
            <input
              :id="`collections-mutate-${key}`"
              v-model="bool[key]"
              type="checkbox"
              class="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 cursor-pointer"
              :data-testid="`collections-mutate-input-${key}`"
              @change="boolTouched[String(key)] = true"
            />
            <span class="text-xs font-semibold" :class="bool[key] ? 'text-indigo-600' : 'text-slate-500'">
              {{ bool[key] ? t("common.yes") : t("common.no") }}
            </span>
          </label>

          <select
            v-else-if="spec.type === 'enum'"
            :id="`collections-mutate-${key}`"
            v-model="text[key]"
            :required="spec.required"
            class="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs bg-slate-50 focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition-all cursor-pointer font-medium text-slate-700"
            :data-testid="`collections-mutate-input-${key}`"
          >
            <option value="">{{ t("collectionsView.selectPlaceholder") }}</option>
            <option v-for="value in spec.values" :key="value" :value="value">{{ value }}</option>
          </select>

          <textarea
            v-else-if="spec.type === 'text' || spec.type === 'markdown'"
            :id="`collections-mutate-${key}`"
            v-model="text[key]"
            :required="spec.required"
            rows="3"
            class="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none font-medium text-slate-700 transition-all"
            :data-testid="`collections-mutate-input-${key}`"
          ></textarea>

          <input
            v-else
            :id="`collections-mutate-${key}`"
            v-model="text[key]"
            :type="inputTypeFor(spec.type, text[key])"
            :step="stepForFieldType(spec.type)"
            :required="spec.required"
            class="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none font-medium text-slate-700 transition-all"
            :data-testid="`collections-mutate-input-${key}`"
          />
        </div>

        <p v-if="error" class="text-xs font-semibold text-red-600 bg-red-50 border border-red-100 p-2.5 rounded-xl" data-testid="collections-mutate-error">
          {{ error }}
        </p>
      </div>

      <div class="flex items-center justify-end gap-2 px-6 py-4">
        <button
          type="button"
          class="h-8 px-3 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 font-bold text-xs transition-colors"
          data-testid="collections-mutate-cancel"
          @click="emit('close')"
        >
          {{ t("common.cancel") }}
        </button>
        <button
          type="submit"
          class="h-8 px-3 rounded bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs transition-colors shadow-sm disabled:opacity-50 flex items-center gap-1"
          :disabled="pending"
          data-testid="collections-mutate-submit"
        >
          <span v-if="pending" class="material-symbols-outlined text-sm animate-spin">progress_activity</span>
          <span>{{ action.label }}</span>
        </button>
      </div>
    </form>
  </CollectionRecordModal>
</template>

<script setup lang="ts">
import { reactive } from "vue";
import { IconGlyph } from "@mulmoclaude/core/plugin-vue";
import { useCollectionI18n } from "../lang";
import CollectionRecordModal from "./CollectionRecordModal.vue";
import { inputTypeFor, stepForFieldType } from "../useCollectionRendering.helpers";
import type { CollectionMutateAction } from "@mulmoclaude/core/collection";

const props = defineProps<{
  action: CollectionMutateAction;
  /** Submit in flight (the POST) — disables the submit button. */
  pending: boolean;
  /** Server rejection (`problem` text) rendered inline; the form stays
   *  open so the user fixes the value and retries. */
  error: string | null;
}>();

const emit = defineEmits<{
  close: [];
  submit: [params: Record<string, unknown>];
}>();

const { t } = useCollectionI18n();

// Draft slots, mirroring the record form's split: strings for everything
// with a text-ish input, booleans for checkboxes (plus a touched flag —
// an optional boolean the user never touched must be OMITTED, not sent
// as false, so a `$params.<bool>` ref preserves the stored value).
const text = reactive<Record<string, string>>({});
const bool = reactive<Record<string, boolean>>({});
const boolTouched = reactive<Record<string, boolean>>({});
for (const [key, spec] of Object.entries(props.action.params ?? {})) {
  if (spec.type === "boolean") bool[key] = false;
  else text[key] = "";
}

/** Convert the draft to the submitted params: numbers parsed, booleans
 *  included only when touched or required, empty optionals OMITTED (the
 *  server treats an absent param as "don't write" for `$params` refs —
 *  merge semantics). */
function submit(): void {
  const params: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(props.action.params ?? {})) {
    if (spec.type === "boolean") {
      if (boolTouched[key] || spec.required) params[key] = bool[key] === true;
      continue;
    }
    const raw = (text[key] ?? "").trim();
    if (raw === "") continue;
    if (spec.type === "number" || spec.type === "money") {
      const num = Number(raw);
      params[key] = Number.isFinite(num) ? num : raw;
      continue;
    }
    params[key] = raw;
  }
  emit("submit", params);
}
</script>
