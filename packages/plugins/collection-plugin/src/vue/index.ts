// @mulmoclaude/collection-plugin/vue — browser UI layer.
//
// The host frontend imports from here (the UI host binding, the rendering
// composable, and the View components). Configure the host binding once at app
// startup — all fields are required (the full CollectionUi contract):
//   import { configureCollectionUi } from "@mulmoclaude/collection-plugin/vue";
//   configureCollectionUi({ fetchCollectionDetail, fileAssetUrl, fileRoutePath, imageSrc });
//
// Styling: the components' Tailwind classes are compiled into the package's
// dist/style.css. The library build EXTRACTS the `import "../style.css"` below
// into that file rather than injecting it at runtime, so a consumer resolving
// `@mulmoclaude/collection-plugin/vue` from node_modules will NOT auto-load the
// rules — the host must `import "@mulmoclaude/collection-plugin/style.css"`
// itself (see uiHost.ts). The import here only covers this package's own dev.
import "../style.css";

import type { ToolPlugin } from "gui-chat-protocol/vue";
import { TOOL_DEFINITION, executePresentCollection, type PresentCollectionData, type PresentCollectionArgs } from "@mulmoclaude/core/collection";
import ChatView from "./chat/View.vue";
import ChatPreview from "./chat/Preview.vue";

export {
  configureCollectionUi,
  collectionUi,
  type CollectionUi,
  type CollectionFetchResult,
  type CollectionApiResult,
  type CollectionMutationResult,
  type CollectionConfirmOptions,
  type CollectionViewToken,
  type CollectionViewHtmlResult,
  type CollectionViewI18nResult,
  type CollectionRemoteViewResult,
  type CollectionRemoteViewMutateResult,
  type CollectionRemoteViewItemsResult,
  type CollectionViewSrcdocBoot,
  type CollectionActionResult,
  type CollectionRefreshResult,
  type RegistryEntry,
  type RegistryListResponse,
  type RegistryImportResponse,
} from "./uiContext";
export {
  useCollectionUi,
  useCollectionUiGetter,
  provideCollectionUi,
  provideCollectionScope,
  resolveScopedCollectionUi,
  resetScopedCollectionUi,
} from "./scopedUi";
export { useCollectionRendering, type CollectionRendering } from "./useCollectionRendering";
export {
  readCollectionViewMode,
  writeCollectionViewMode,
  readCollectionSort,
  writeCollectionSort,
  readCollectionFlagFilters,
  writeCollectionFlagFilters,
  customViewKey,
  applicableViewModes,
  type CollectionViewMode,
  type BuiltInViewMode,
  type CustomViewMode,
  type FlagFilterMode,
  type FlagFilterState,
} from "./collectionViewMode";
export { decideSearchChannelClaim, MAX_FRAME_RECLAIMS, type SearchChannelAction, type SearchChannelState } from "./searchChannelPolicy";
export { default as CollectionRecordModal } from "./components/CollectionRecordModal.vue";
export { default as CollectionEmbedView } from "./components/CollectionEmbedView.vue";
export { default as CollectionCalendarView } from "./components/CollectionCalendarView.vue";
export { default as CollectionDayView } from "./components/CollectionDayView.vue";
export { default as CollectionKanbanView } from "./components/CollectionKanbanView.vue";
export { default as CollectionRecordPanel } from "./components/CollectionRecordPanel.vue";
export { default as CollectionViewConfigModal } from "./components/CollectionViewConfigModal.vue";
export { default as CollectionCustomView } from "./components/CollectionCustomView.vue";
export { default as CollectionView } from "./components/CollectionView.vue";
export { default as CollectionsIndexView } from "./components/CollectionsIndexView.vue";
export { default as FeedsView } from "./components/FeedsView.vue";

// ── presentCollection ToolPlugin (the chat-result registration shape, like
//    chart/form/markdown). A runtime host (MulmoTerminal) registers `{ plugin }`
//    directly; a built-in host (MulmoClaude) wraps `viewComponent`/`previewComponent`
//    in its own scope. ──
export const plugin: ToolPlugin<PresentCollectionData, PresentCollectionData, PresentCollectionArgs> = {
  toolDefinition: TOOL_DEFINITION,
  execute: executePresentCollection,
  generatingMessage: "Loading collection...",
  isEnabled: () => true,
  viewComponent: ChatView,
  previewComponent: ChatPreview,
};

export { ChatView as PresentCollectionView, ChatPreview as PresentCollectionPreview };
