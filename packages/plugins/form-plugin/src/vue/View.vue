<template>
  <div class="w-full h-full overflow-y-auto p-8" data-testid="present-form-view">
    <div v-if="formData" class="max-w-3xl w-full mx-auto">
      <h2 v-if="formData.title" class="text-gray-900 text-3xl font-bold mb-4 text-center">
        {{ formData.title }}
      </h2>

      <p v-if="formData.description" class="text-gray-600 text-center mb-8 text-lg">
        {{ formData.description }}
      </p>

      <div v-if="showErrorSummary && fieldErrors.size > 0" class="bg-red-50 border-2 border-red-500 rounded-lg p-4 mb-6" role="alert">
        <h3 class="text-red-800 font-semibold mb-2 flex items-center gap-2">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clip-rule="evenodd"
            />
          </svg>
          {{ t.errorSummary }}
        </h3>
        <ul class="text-red-700 space-y-1">
          <li v-for="[fieldId, error] in fieldErrors" :key="fieldId">
            <a :href="`#${fieldId}`" class="hover:underline cursor-pointer" @click.prevent="focusField(fieldId)">
              {{ error.message }}
            </a>
          </li>
        </ul>
      </div>

      <form class="space-y-6" @submit.prevent="handleSubmit">
        <template v-for="field in formData.fields" :key="field.id">
          <section v-if="field.type === 'excerpt'" :id="field.id" data-testid="form-excerpt">
            <h3 class="text-gray-800 font-semibold mb-2">{{ field.label }}</h3>
            <blockquote class="border-l-4 border-amber-400 bg-gray-50 rounded-r-lg px-4 py-3 text-gray-800 leading-relaxed">
              <component
                :is="segment.highlighted ? 'mark' : 'span'"
                v-for="(segment, index) in splitExcerpt(field.text, field.highlights)"
                :key="index"
                class="whitespace-pre-wrap"
                :class="{ 'bg-amber-200 text-gray-900 rounded px-0.5': segment.highlighted }"
                >{{ segment.text }}</component
              >
            </blockquote>
            <p v-if="field.description" class="text-gray-600 text-sm mt-2">{{ field.description }}</p>
          </section>
          <div v-else :id="field.id" class="transition-all duration-200 ease-[ease]" :class="{ 'animate-shake': hasError(field.id) && touched.has(field.id) }">
            <label
              :for="`input-${field.id}`"
              class="block text-gray-800 font-semibold mb-2"
              :class="{
                'text-red-600': hasError(field.id) && touched.has(field.id),
              }"
            >
              {{ field.label }}
              <span v-if="field.required" class="text-red-500 ml-1" aria-label="required">{{ t.requiredMarker }}</span>
            </label>

            <p v-if="field.description" class="text-gray-600 text-sm mb-2">
              {{ field.description }}
            </p>

            <input
              v-if="field.type === 'text'"
              :id="`input-${field.id}`"
              v-model="formValues[field.id]"
              type="text"
              :placeholder="field.placeholder"
              :aria-invalid="hasError(field.id) && touched.has(field.id)"
              :aria-describedby="hasError(field.id) && touched.has(field.id) ? `${field.id}-error` : undefined"
              class="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              :class="{
                'border-red-500 focus:ring-red-500': hasError(field.id) && touched.has(field.id),
                'border-gray-300': !hasError(field.id) || !touched.has(field.id),
              }"
              @blur="handleBlur(field.id)"
              @input="handleInput(field.id)"
            />

            <textarea
              v-else-if="field.type === 'textarea'"
              :id="`input-${field.id}`"
              v-model="formValues[field.id]"
              :placeholder="field.placeholder"
              :rows="field.rows || 4"
              :aria-invalid="hasError(field.id) && touched.has(field.id)"
              :aria-describedby="hasError(field.id) && touched.has(field.id) ? `${field.id}-error` : undefined"
              class="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors resize-y"
              :class="{
                'border-red-500 focus:ring-red-500': hasError(field.id) && touched.has(field.id),
                'border-gray-300': !hasError(field.id) || !touched.has(field.id),
              }"
              @blur="handleBlur(field.id)"
              @input="handleInput(field.id)"
            />

            <input
              v-else-if="field.type === 'number'"
              :id="`input-${field.id}`"
              v-model.number="formValues[field.id]"
              type="number"
              :min="field.min"
              :max="field.max"
              :step="field.step"
              :aria-invalid="hasError(field.id) && touched.has(field.id)"
              :aria-describedby="hasError(field.id) && touched.has(field.id) ? `${field.id}-error` : undefined"
              class="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              :class="{
                'border-red-500 focus:ring-red-500': hasError(field.id) && touched.has(field.id),
                'border-gray-300': !hasError(field.id) || !touched.has(field.id),
              }"
              @blur="handleBlur(field.id)"
              @input="handleInput(field.id)"
            />

            <input
              v-else-if="field.type === 'date'"
              :id="`input-${field.id}`"
              v-model="formValues[field.id]"
              type="date"
              :min="field.minDate"
              :max="field.maxDate"
              :aria-invalid="hasError(field.id) && touched.has(field.id)"
              :aria-describedby="hasError(field.id) && touched.has(field.id) ? `${field.id}-error` : undefined"
              class="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              :class="{
                'border-red-500 focus:ring-red-500': hasError(field.id) && touched.has(field.id),
                'border-gray-300': !hasError(field.id) || !touched.has(field.id),
              }"
              @blur="handleBlur(field.id)"
              @change="handleInput(field.id)"
            />

            <input
              v-else-if="field.type === 'time'"
              :id="`input-${field.id}`"
              v-model="formValues[field.id]"
              type="time"
              :aria-invalid="hasError(field.id) && touched.has(field.id)"
              :aria-describedby="hasError(field.id) && touched.has(field.id) ? `${field.id}-error` : undefined"
              class="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              :class="{
                'border-red-500 focus:ring-red-500': hasError(field.id) && touched.has(field.id),
                'border-gray-300': !hasError(field.id) || !touched.has(field.id),
              }"
              @blur="handleBlur(field.id)"
              @change="handleInput(field.id)"
            />

            <div
              v-else-if="field.type === 'radio'"
              class="space-y-2"
              role="radiogroup"
              :aria-invalid="hasError(field.id) && touched.has(field.id)"
              :aria-describedby="hasError(field.id) && touched.has(field.id) ? `${field.id}-error` : undefined"
            >
              <label
                v-for="(choice, index) in field.choices"
                :key="index"
                class="flex items-center p-3 border-2 border-gray-300 rounded-lg cursor-pointer transition-all hover:bg-gray-50"
                :class="{
                  'border-blue-500 bg-blue-50': formValues[field.id] === index,
                  'border-gray-300': formValues[field.id] !== index,
                }"
              >
                <input
                  v-model="formValues[field.id]"
                  type="radio"
                  :name="field.id"
                  :value="index"
                  class="mr-3 h-4 w-4 flex-shrink-0"
                  @change="handleInput(field.id)"
                  @blur="handleBlur(field.id)"
                />
                <span class="text-gray-800">{{ getChoiceLabel(choice) }}</span>
              </label>
            </div>

            <select
              v-else-if="field.type === 'dropdown'"
              :id="`input-${field.id}`"
              v-model="formValues[field.id]"
              :aria-invalid="hasError(field.id) && touched.has(field.id)"
              :aria-describedby="hasError(field.id) && touched.has(field.id) ? `${field.id}-error` : undefined"
              class="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors bg-white"
              :class="{
                'border-red-500 focus:ring-red-500': hasError(field.id) && touched.has(field.id),
                'border-gray-300': !hasError(field.id) || !touched.has(field.id),
              }"
              @blur="handleBlur(field.id)"
              @change="handleInput(field.id)"
            >
              <option :value="null" disabled>{{ t.selectOption }}</option>
              <option v-for="(choice, index) in field.choices" :key="index" :value="index">
                {{ getChoiceLabel(choice) }}
              </option>
            </select>

            <div
              v-else-if="field.type === 'checkbox'"
              class="space-y-2"
              role="group"
              :aria-invalid="hasError(field.id) && touched.has(field.id)"
              :aria-describedby="hasError(field.id) && touched.has(field.id) ? `${field.id}-error` : undefined"
            >
              <label
                v-for="(choice, index) in field.choices"
                :key="index"
                class="flex items-center p-3 border-2 border-gray-300 rounded-lg cursor-pointer transition-all hover:bg-gray-50"
                :class="{
                  'border-blue-500 bg-blue-50': (formValues[field.id] || []).includes(index),
                  'border-gray-300': !(formValues[field.id] || []).includes(index),
                }"
              >
                <input
                  v-model="formValues[field.id]"
                  type="checkbox"
                  :value="index"
                  class="mr-3 h-4 w-4 flex-shrink-0"
                  @change="handleInput(field.id)"
                  @blur="handleBlur(field.id)"
                />
                <span class="text-gray-800">{{ getChoiceLabel(choice) }}</span>
              </label>
            </div>

            <div
              v-if="hasError(field.id) && touched.has(field.id)"
              :id="`${field.id}-error`"
              class="flex items-center gap-2 mt-2 text-red-600 text-sm"
              role="alert"
            >
              <svg class="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path
                  fill-rule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clip-rule="evenodd"
                />
              </svg>
              {{ fieldErrors.get(field.id)?.message }}
            </div>

            <div
              v-if="showCharCount(field)"
              class="text-sm mt-2"
              :class="{
                'text-amber-600 font-semibold': isNearLimit(field),
                'text-gray-500': !isNearLimit(field),
              }"
            >
              <template v-if="field.maxLength">
                {{ t.charactersCount((formValues[field.id] || "").length, field.maxLength) }}
              </template>
              <template v-else>
                {{ t.charactersCountNoMax((formValues[field.id] || "").length) }}
              </template>
            </div>
          </div>
        </template>

        <div class="mt-8 flex justify-center">
          <button
            type="submit"
            :disabled="submitted"
            :class="submitted ? 'bg-green-600 cursor-default' : 'bg-blue-600 hover:bg-blue-700'"
            class="px-8 py-3 rounded-lg text-white font-semibold text-lg transition-colors"
          >
            {{ submitted ? t.submitted : t.submit }}
          </button>
        </div>

        <div class="mt-4 text-center text-gray-600 text-sm">
          {{ t.progress(filledRequiredCount, requiredFieldsCount) }}
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from "vue";
import type { ToolResult } from "gui-chat-protocol";
import type { FormData, FormField, InputField, TextField, TextareaField, NumberField, DateField, CheckboxField } from "../core/types";
import { isInputField, splitExcerpt } from "../core/excerpt";
import { toFormViewState, type FormViewState } from "../core/viewState";
import { useT } from "../lang";

const t = useT();

interface FieldError {
  fieldId: string;
  message: string;
  type: "required" | "format" | "range" | "pattern" | "custom";
}

const props = defineProps<{
  selectedResult: ToolResult | null;
  sendTextMessage: (text?: string) => void;
}>();

const emit = defineEmits<{
  updateResult: [result: ToolResult];
}>();

const formData = ref<FormData | null>(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const formValues = ref<Record<string, any>>({});
const touched = ref<Set<string>>(new Set());
const fieldErrors = ref<Map<string, FieldError>>(new Map());
const submitted = ref<boolean>(false);
const showErrorSummary = ref<boolean>(false);
const isRestoring = ref<boolean>(false);

const inputFields = computed<InputField[]>(() => formData.value?.fields.filter(isInputField) ?? []);

function isFreshResult(newResult: ToolResult, oldResult: ToolResult | null | undefined): boolean {
  return !oldResult || !oldResult.jsonData || oldResult.uuid !== newResult.uuid || oldResult.jsonData !== newResult.jsonData;
}

function restoreViewState(state: FormViewState): void {
  Object.assign(formValues.value, state.userResponses);
  touched.value = new Set(state.touched);
  state.touched.forEach((fieldId) => validateField(fieldId));
  if (state.submitted !== undefined) submitted.value = state.submitted;
}

function applyNewResult(newResult: ToolResult): void {
  isRestoring.value = true;
  formData.value = newResult.jsonData as FormData;
  formValues.value = {};
  formData.value.fields.filter(isInputField).forEach((field) => {
    formValues.value[field.id] = getDefaultValue(field);
  });
  const viewState = toFormViewState(newResult.viewState);
  if (viewState) restoreViewState(viewState);
  isRestoring.value = false;
}

watch(
  () => props.selectedResult,
  (newResult, oldResult) => {
    if (!newResult || newResult.toolName !== "presentForm" || !newResult.jsonData) return;
    if (!isFreshResult(newResult, oldResult)) return;
    applyNewResult(newResult);
  },
  { immediate: true },
);

watch(
  [formValues, touched, submitted],
  () => {
    if (isRestoring.value || !props.selectedResult) return;

    const updatedResult: ToolResult = {
      ...props.selectedResult,
      viewState: {
        userResponses: { ...formValues.value },
        touched: Array.from(touched.value),
        submitted: submitted.value,
      },
    };
    emit("updateResult", updatedResult);
  },
  { deep: true },
);

function getChoiceLabel(choice: unknown): string {
  if (!choice) return "";
  if (typeof choice === "string") return choice;
  if (typeof choice === "object") {
    if ("label" in choice && choice.label !== undefined && choice.label !== null) {
      return String((choice as { label: unknown }).label || "");
    }
    if ("value" in choice && choice.value !== undefined && choice.value !== null) {
      return String((choice as { value: unknown }).value || "");
    }
  }
  return String(choice);
}

function getChoiceValue(choice: unknown): string {
  if (!choice) return "";
  if (typeof choice === "string") return choice;
  if (typeof choice === "object") {
    if ("value" in choice && choice.value !== undefined && choice.value !== null) {
      return String((choice as { value: unknown }).value || "");
    }
    if ("label" in choice && choice.label !== undefined && choice.label !== null) {
      return String((choice as { label: unknown }).label || "");
    }
  }
  return String(choice);
}

function matchChoice(choice: unknown, val: unknown): boolean {
  if (choice === val) return true;
  if (!choice) return false;

  const choiceVal = getChoiceValue(choice);
  const choiceLabel = getChoiceLabel(choice);

  let targetVal = val;
  if (val && typeof val === "object") {
    if ("value" in val) {
      targetVal = (val as { value: unknown }).value;
    } else if ("label" in val) {
      targetVal = (val as { label: unknown }).label;
    }
  }

  return String(choiceVal) === String(targetVal) || String(choiceLabel) === String(targetVal);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertProvidedDefault(field: FormField, provided: any): any {
  if (field.type === "radio" || field.type === "dropdown") {
    const choiceIndex = field.choices.findIndex((choice) => matchChoice(choice, provided));
    return choiceIndex !== -1 ? choiceIndex : null;
  }
  if (field.type === "checkbox") {
    if (!Array.isArray(provided)) return [];
    return provided.map((val: unknown) => field.choices.findIndex((choice) => matchChoice(choice, val))).filter((idx: number) => idx !== -1);
  }
  return provided;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emptyValueForField(field: FormField): any {
  if (field.type === "text" || field.type === "textarea" || field.type === "date" || field.type === "time") return "";
  if (field.type === "number") return (field as NumberField).min !== undefined ? (field as NumberField).min : 0;
  if (field.type === "checkbox") return [];
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDefaultValue(field: FormField): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provided = (field as FormField & { defaultValue?: any }).defaultValue;
  if (provided !== undefined) return convertProvidedDefault(field, provided);
  return emptyValueForField(field);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isEmpty(value: any): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// 254 per RFC 5321; bounding upfront keeps the regex below from backtracking.
const EMAIL_MAX_LENGTH = 254;
function isValidEmail(email: string): boolean {
  if (!email || email.length > EMAIL_MAX_LENGTH) return false;
  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex !== email.lastIndexOf("@")) return false;
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  if (/\s/.test(local) || /\s/.test(domain)) return false;
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isValidPhone(phone: string): boolean {
  const phoneRegex = /^[\d\s\-+()]+$/;
  return phoneRegex.test(phone) && phone.replace(/\D/g, "").length >= 10;
}

function validateText(field: TextField, value: string): string | null {
  if (field.validation === "email" && !isValidEmail(value)) return "Please enter a valid email address";
  if (field.validation === "url" && !isValidUrl(value)) return "Please enter a valid URL";
  if (field.validation === "phone" && !isValidPhone(value)) return "Please enter a valid phone number";
  if (typeof field.validation === "string" && !["email", "url", "phone"].includes(field.validation)) {
    try {
      if (!new RegExp(field.validation).test(value)) return `${field.label} format is invalid`;
    } catch {
      console.warn(`Invalid regex pattern: ${field.validation}`);
    }
  }
  return null;
}

function validateTextarea(field: TextareaField, value: string): string | null {
  if (field.minLength && value.length < field.minLength) {
    return `Must be at least ${field.minLength} characters (currently ${value.length})`;
  }
  if (field.maxLength && value.length > field.maxLength) {
    return `Must be no more than ${field.maxLength} characters (currently ${value.length})`;
  }
  return null;
}

function validateNumber(field: NumberField, value: number): string | null {
  if (field.min !== undefined && value < field.min) return `Must be at least ${field.min}`;
  if (field.max !== undefined && value > field.max) return `Must be no more than ${field.max}`;
  return null;
}

function validateDate(field: DateField, value: string): string | null {
  if (field.minDate && value < field.minDate) return `Date must be on or after ${field.minDate}`;
  if (field.maxDate && value > field.maxDate) return `Date must be on or before ${field.maxDate}`;
  return null;
}

function validateCheckbox(field: CheckboxField, value: number[]): string | null {
  const selectedCount = value?.length || 0;
  if (field.minSelections && selectedCount < field.minSelections) {
    return `Please select at least ${field.minSelections} option${field.minSelections > 1 ? "s" : ""}`;
  }
  if (field.maxSelections && selectedCount > field.maxSelections) {
    return `Please select no more than ${field.maxSelections} option${field.maxSelections > 1 ? "s" : ""}`;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getErrorMessage(field: FormField, value: any): string | null {
  if (field.required && isEmpty(value)) return `${field.label} is required`;
  if (isEmpty(value)) return null;
  if (field.type === "text") return validateText(field as TextField, value);
  if (field.type === "textarea") return validateTextarea(field as TextareaField, value);
  if (field.type === "number") return validateNumber(field as NumberField, value);
  if (field.type === "date") return validateDate(field as DateField, value);
  if (field.type === "checkbox") return validateCheckbox(field as CheckboxField, value);
  return null;
}

function validateField(fieldId: string): boolean {
  const field = inputFields.value.find((candidate) => candidate.id === fieldId);
  if (!field) return true;

  const value = formValues.value[fieldId];
  const errorMessage = getErrorMessage(field, value);

  if (errorMessage) {
    fieldErrors.value.set(fieldId, {
      fieldId,
      message: errorMessage,
      type: "custom",
    });
    return false;
  }
  fieldErrors.value.delete(fieldId);
  return true;
}

function handleBlur(fieldId: string): void {
  touched.value.add(fieldId);
  validateField(fieldId);
}

function handleInput(fieldId: string): void {
  if (touched.value.has(fieldId)) {
    validateField(fieldId);
  }
}

function hasError(fieldId: string): boolean {
  return fieldErrors.value.has(fieldId);
}

function focusField(fieldId: string): void {
  const element = document.getElementById(`input-${fieldId}`);
  if (element) {
    element.focus();
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function showCharCount(field: FormField): boolean {
  return (field.type === "text" || field.type === "textarea") && (field as TextField | TextareaField).maxLength !== undefined;
}

function isNearLimit(field: FormField): boolean {
  if (field.type !== "text" && field.type !== "textarea") return false;
  const { maxLength } = field as TextField | TextareaField;
  if (!maxLength) return false;
  const currentLength = (formValues.value[field.id] || "").length;
  return currentLength / maxLength > 0.9;
}

const requiredFieldsCount = computed(() => inputFields.value.filter((field) => field.required).length);

const filledRequiredCount = computed(() => inputFields.value.filter((field) => field.required && !isEmpty(formValues.value[field.id])).length);

function handleSubmit(): void {
  if (submitted.value) return;

  inputFields.value.forEach((field) => {
    touched.value.add(field.id);
    validateField(field.id);
  });

  if (fieldErrors.value.size > 0) {
    showErrorSummary.value = true;
    const [firstErrorFieldId] = Array.from(fieldErrors.value.keys());
    if (firstErrorFieldId !== undefined) focusField(firstErrorFieldId);
    return;
  }

  const lines: string[] = [];
  if (formData.value?.title) lines.push(`**${singleLine(formData.value.title)}**`, "");
  inputFields.value.forEach((field) => {
    lines.push(`- ${singleLine(field.label)}: ${renderValue(field, formValues.value[field.id])}`);
  });

  submitted.value = true;
  props.sendTextMessage(lines.join("\n"));
}

// Indent so multi-line text/textarea values stay attached to their bullet
// instead of opening a new top-level item under markdown rules.
function indentContinuation(text: string): string {
  return text.replace(/\n/g, "\n  ");
}

// LLM-authored title/label/choice strings — collapse any newline so they
// can't smuggle phantom bullets into the payload.
function singleLine(text: unknown): string {
  if (typeof text !== "string") {
    return getChoiceLabel(text);
  }
  return text
    .split(/\r?\n/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join(" ");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderValue(field: FormField, value: any): string {
  const empty = "(none)";
  if (field.type === "radio" || field.type === "dropdown") {
    return value !== null && value !== undefined ? singleLine(field.choices[value]) : empty;
  }
  // Sublist (not comma-join): a choice label containing a comma would otherwise
  // be indistinguishable from two separate selections.
  if (field.type === "checkbox") {
    const items: string[] = (value || []).map((idx: number) => singleLine(field.choices[idx]));
    if (items.length === 0) return empty;
    return `\n  - ${items.join("\n  - ")}`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? empty : indentContinuation(trimmed);
  }
  if (value === null || value === undefined) return empty;
  return String(value);
}
</script>
