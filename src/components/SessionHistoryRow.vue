<template>
  <!-- Not a control itself: the open button, the bookmark toggle and the
       menu are siblings inside it, so none nests in another. The card's
       own click is a mouse-only convenience; keyboard users have the open
       button. -->
  <div
    class="relative cursor-pointer rounded p-2 text-sm transition-colors"
    :title="primaryText"
    :class="rowClasses"
    :data-testid="`session-item-${session.id}`"
    @click="emit('select', session.id)"
  >
    <!-- Primary line prefers the AI-generated summary (chat indexer,
         #123) when present — it's typically more informative than
         the first user message. Fall back to the first user message,
         then to a "no messages" placeholder. `line-clamp-2` lets a
         summary wrap so more of it is readable at a glance; the raw
         first-message fallback stays on a single line via `truncate`
         so short prompts don't disturb row heights. -->
    <div class="flex items-start gap-1.5">
      <button
        type="button"
        class="flex-shrink-0 mt-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        :title="bookmarkLabel"
        :aria-label="bookmarkLabel"
        :aria-pressed="session.isBookmarked === true"
        :data-testid="`session-row-icon-bookmark-${session.id}`"
        @click.stop="emit('toggleBookmark', session)"
      >
        <SessionRoleIcon :session="session" :roles="roles" size="sm" />
      </button>
      <button
        type="button"
        class="flex flex-1 min-w-0 items-start gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        :aria-label="rowAria"
        :aria-current="selected ? 'true' : undefined"
        :data-testid="`session-row-open-${session.id}`"
        @click.stop="emit('select', session.id)"
      >
        <p class="flex-1 min-w-0" :class="[previewClasses, hasVisibleSummary ? 'line-clamp-2' : 'truncate']">
          {{ primaryText }}
        </p>
        <span v-if="session.isRunning" class="flex-shrink-0 flex items-center mt-0.5" :aria-label="t('sessionHistoryPanel.running')">
          <span class="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
        </span>
      </button>
    </div>
    <!-- Timestamp pill straddling the top border, mirroring the
         SessionSidebar card design. The kebab "..." button sits
         next to it on the same border line — clicking opens a
         popover with delete + bookmark actions. It comes last in the
         markup so the tab order runs bookmark, open, menu. The running
         indicator still renders inline in the meta line
         (it's a status, not a time); unread is signalled through
         previewClasses (bold text); bookmark state is signalled
         via the green role icon. -->
    <div class="absolute top-0 right-6 -translate-y-1/2 flex items-center gap-1 bg-white px-1 leading-none">
      <span class="text-[10px] text-gray-400 pointer-events-none">{{ formattedDate }}</span>
      <button
        type="button"
        class="flex items-center justify-center px-0.5 border border-gray-300 rounded-md text-gray-400 hover:text-gray-700 hover:border-gray-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400"
        :aria-label="t('sessionHistoryPanel.rowMenuAria')"
        :data-testid="`session-row-menu-${session.id}`"
        @click.stop="emit('toggleMenu', session.id)"
      >
        <span class="material-icons !text-[14px] leading-none" aria-hidden="true">more_horiz</span>
      </button>
    </div>
    <div
      v-if="menuOpen"
      class="absolute top-2 right-2 z-10 min-w-[140px] rounded border border-gray-200 bg-white shadow-md py-1 text-xs"
      role="menu"
      :data-testid="`session-row-menu-popover-${session.id}`"
      @click.stop
    >
      <button
        type="button"
        role="menuitem"
        class="block w-full text-left px-3 py-1.5 hover:bg-gray-100"
        :data-testid="`session-row-bookmark-${session.id}`"
        @click.stop="emit('toggleBookmark', session)"
      >
        {{ session.isBookmarked ? t("sessionHistoryPanel.unbookmark") : t("sessionHistoryPanel.bookmark") }}
      </button>
      <button
        type="button"
        role="menuitem"
        class="block w-full text-left px-3 py-1.5 text-red-600 hover:bg-red-50"
        :data-testid="`session-row-delete-${session.id}`"
        @click.stop="emit('deleteSession', session)"
      >
        {{ t("sessionHistoryPanel.delete") }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
// One row of the session-history list, split out of
// SessionHistoryPanel so that selecting a session re-renders only the
// two rows whose `selected` flipped. Measured at 800 sessions, the
// wholesale re-render cost 100-300 ms of unresponsive UI per click.
//
// Two things keep the skip working, and both are easy to undo by
// accident:
//   - the parent must pass method references, never inline arrows
//     closing over the v-for variable (a fresh function each render
//     makes the props compare fail, so every row re-renders again)
//   - every derived string is a `computed`, so date formatting and
//     i18n interpolation survive a re-render instead of re-running
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { Role } from "../config/roles";
import type { SessionSummary } from "../types/session";
import { resolveSessionPrimaryText, sessionHasVisibleSummary } from "../utils/session/sessionPreview";
import { formatDate } from "../utils/format/date";
import SessionRoleIcon from "./SessionRoleIcon.vue";

const { t } = useI18n();

const props = defineProps<{
  session: SessionSummary;
  roles: Role[];
  selected: boolean;
  menuOpen: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
  toggleMenu: [id: string];
  toggleBookmark: [session: SessionSummary];
  deleteSession: [session: SessionSummary];
}>();

// Same call feeds the visible text, the aria-label, and the hover
// title so all three stay in lockstep. `null` from the resolver means
// "nothing to show" — the localised placeholder is applied here rather
// than in the pure helper.
const primaryText = computed(() => resolveSessionPrimaryText(props.session) ?? t("sessionHistoryPanel.noMessages"));

const rowAria = computed(() => t("sessionHistoryPanel.openRowAria", { preview: primaryText.value }));

const bookmarkLabel = computed(() => (props.session.isBookmarked ? t("sessionHistoryPanel.unbookmark") : t("sessionHistoryPanel.bookmark")));

const formattedDate = computed(() => formatDate(props.session.updatedAt));

const hasVisibleSummary = computed(() => sessionHasVisibleSummary(props.session));

const rowClasses = computed(() => (props.selected ? "border-2 border-blue-500 hover:bg-gray-50" : "border border-gray-200 hover:bg-gray-50"));

const previewClasses = computed(() => (props.session.hasUnread ? "text-gray-900 font-bold" : "text-gray-700"));
</script>
