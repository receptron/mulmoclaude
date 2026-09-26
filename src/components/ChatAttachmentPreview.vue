<template>
  <div data-testid="chat-attachment-preview" class="relative inline-flex items-center gap-2 border border-gray-300 rounded overflow-hidden px-2 py-1">
    <img v-if="imageSrc" :src="imageSrc" alt="Attached image" class="max-h-20 max-w-40 object-contain" />
    <div v-else class="flex items-center gap-1.5 text-xs text-gray-700">
      <span class="material-icons text-base" :class="iconColor">{{ icon }}</span>
      <div class="flex flex-col">
        <span class="max-w-40 truncate">{{ filename || t("chatInput.attachmentFallbackName") }}</span>
        <span v-if="!readable" class="text-[10px] text-amber-700" data-testid="chat-attachment-file-only">{{ t("chatInput.fileOnlyAttachment") }}</span>
      </div>
    </div>
    <button
      data-testid="chat-attachment-remove"
      class="absolute top-0 right-0 bg-black/60 text-white rounded-bl px-1 text-xs leading-tight hover:bg-black/80"
      :aria-label="removeLabel"
      :title="removeLabel"
      @click="emit('remove')"
    >
      ✕
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { isReadableAttachmentType } from "../utils/attachment/readableTypes";

const { t } = useI18n();

const props = defineProps<{
  /** Original file bytes as a data URL. Passed straight to the
   *  upload pipeline. Also used as the `<img>` source when the
   *  browser can render `mime` natively. */
  dataUrl: string;
  /** Browser-decoded JPEG data URL for MIMEs Chrome can't render
   *  (HEIC / HEIF). Populated by `ChatInput`'s pick pipeline when
   *  needed. If left undefined for an unrenderable MIME the chip
   *  drops back to the file-icon variant. */
  previewDataUrl?: string | undefined;
  filename: string;
  mime: string;
}>();
const emit = defineEmits<{ remove: [] }>();

const removeLabel = computed(() => t("chatInput.removeAttachment", { name: props.filename || t("chatInput.attachmentFallbackName") }));

// MIMEs Chrome renders directly in an `<img>` tag. HEIC / HEIF and
// TIFF are absent — those either arrive with a `previewDataUrl`
// filled in upstream or fall back to the file-icon chip.
// `image/jpg` is a common non-standard alias the browser's file
// picker occasionally emits alongside `image/jpeg` — kept in the
// set so a `.jpg` pick doesn't regress to the file-icon chip
// (codex review on #2000).
const BROWSER_RENDERABLE_IMAGE_MIMES = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp"]);

const imageSrc = computed(() => {
  if (props.previewDataUrl) return props.previewDataUrl;
  if (BROWSER_RENDERABLE_IMAGE_MIMES.has(props.mime)) return props.dataUrl;
  return "";
});

const readable = computed(() => isReadableAttachmentType(props.mime));

const icon = computed(() => {
  if (props.mime === "application/pdf") return "picture_as_pdf";
  if (props.mime.includes("wordprocessingml")) return "description";
  if (props.mime.includes("spreadsheetml")) return "table_chart";
  if (props.mime.includes("presentationml")) return "slideshow";
  return "insert_drive_file";
});

const iconColor = computed(() => {
  if (props.mime === "application/pdf") return "text-red-500";
  if (props.mime.includes("wordprocessingml")) return "text-blue-500";
  if (props.mime.includes("spreadsheetml")) return "text-green-600";
  if (props.mime.includes("presentationml")) return "text-orange-500";
  return "text-gray-500";
});
</script>
