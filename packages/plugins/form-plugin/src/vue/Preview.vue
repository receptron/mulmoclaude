<template>
  <div class="w-full h-full flex flex-col items-center justify-center p-4 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg border-2 border-gray-200">
    <div class="text-center">
      <svg class="w-12 h-12 mx-auto mb-3 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>

      <h3 class="text-gray-900 font-bold text-lg mb-1 line-clamp-2">
        {{ formData?.title || t.fallbackTitle }}
      </h3>

      <p class="text-gray-600 text-sm mb-2">{{ t.fieldCount(fieldCount) }}</p>

      <div v-if="!isSubmitted" class="flex items-center justify-center gap-2">
        <div class="w-32 h-2 bg-gray-200 rounded-full overflow-hidden">
          <div class="h-full bg-blue-600 transition-all duration-300" :style="{ width: `${completionPercentage}%` }" />
        </div>
        <span class="text-xs text-gray-500">{{ `${completionPercentage}%` }}</span>
      </div>

      <div v-else class="inline-flex items-center gap-1 px-3 py-1 bg-green-100 text-green-700 rounded-full text-xs font-semibold">
        <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
          <path
            fill-rule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
            clip-rule="evenodd"
          />
        </svg>
        {{ t.submitted }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ToolResult } from "gui-chat-protocol";
import type { FormData } from "../core/types";
import { toFormViewState, type FormViewState } from "../core/viewState";
import { isInputField } from "../core/excerpt";
import { useT } from "../lang";

const t = useT();

const props = defineProps<{
  result: ToolResult;
}>();

const formData = computed<FormData | null>(() => {
  if (props.result?.toolName === "presentForm") {
    return (props.result.data ?? props.result.jsonData) as FormData;
  }
  return null;
});

const viewState = computed<FormViewState | null>(() => toFormViewState(props.result?.viewState));

const inputFields = computed(() => formData.value?.fields.filter(isInputField) ?? []);

const fieldCount = computed(() => inputFields.value.length);

const isSubmitted = computed(() => viewState.value?.submitted || false);

const completionPercentage = computed(() => {
  if (!formData.value || isSubmitted.value) return 100;

  const requiredFields = inputFields.value.filter((field) => field.required);
  if (requiredFields.length === 0) return 0;

  const responses = viewState.value?.userResponses || {};
  const filledRequired = requiredFields.filter((field) => {
    const value = responses[field.id];
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.trim() !== "";
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }).length;

  return Math.round((filledRequired / requiredFields.length) * 100);
});
</script>
