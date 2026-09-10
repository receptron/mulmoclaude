// #1575 — the View offers the interactive beat editor (@mulmocast/beat-editor) beside the
// per-beat list. Each editor emit fires
// `update:script`; this debounces them into one updateScript round-trip per
// quiet stretch (300ms — short enough to feel live, long enough that typing in
// the Inspector doesn't carpet-bomb the server).

import { computed, ref, type ComputedRef, type Ref } from "vue";
import { hasEditableBeats } from "../helpers";
import type { MulmoScriptDispatchResult } from "../../core/contract";
import type { MulmoScriptTransport, TransportResult } from "../transport";
import type { DeckScriptShape, MulmoScript } from "../viewTypes";

const DECK_SAVE_DEBOUNCE_MS = 300;

/**
 * Who this editor is, on the wire.
 *
 * Every write carries it so the server's "this script changed" broadcast can be told apart
 * from someone else's. Without it a save would echo back and reload the editor mid-keystroke,
 * rebuilding the element the caret sits in.
 *
 * Per module instance rather than per component: one View is mounted at a time, and a value
 * that survives a remount keeps a save in flight from being mistaken for a foreign write.
 */
const EDITOR_ORIGIN = `deck-editor-${Math.random().toString(36).slice(2)}`;

/**
 * The slice of the transport this composable uses.
 *
 * `MulmoScriptTransport["call"]` is generic in the dispatch kind, so a fake standing in for it
 * has to answer every kind — impossible to write without a cast. Naming the ONE call made here
 * is what lets the save path (and its failure) be tested; the real transport satisfies this
 * structurally, so the View passes the same object it always did.
 */
export type DeckEditorTransport = Pick<MulmoScriptTransport, "onScriptChanged"> & {
  call(
    kind: "updateScript",
    args: { filePath: string; script: MulmoScript; origin: string },
  ): Promise<TransportResult<MulmoScriptDispatchResult["updateScript"]>>;
};

export interface UseDeckEditorOptions {
  api: DeckEditorTransport;
  filePath: ComputedRef<string>;
  effectiveScript: ComputedRef<MulmoScript>;
  /** Persist the saved script back into the parent's toolResult so the
   *  in-memory script and reactive beats[] stay in sync without a remount. */
  commitScript: (next: MulmoScript) => void;
}

export function useDeckEditor({ api, filePath, effectiveScript, commitScript }: UseDeckEditorOptions) {
  const canEditBeats = computed(() => hasEditableBeats(effectiveScript.value));
  const deckScriptInput = computed<DeckScriptShape>(() => effectiveScript.value as unknown as DeckScriptShape);

  let deckSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingDeckScript: MulmoScript | null = null;

  /**
   * The last save that failed, in the server's own words — or null.
   *
   * A failed save leaves the editor showing the user's edit (see `flushDeckSave`), which is
   * right for a transient failure and indistinguishable from success without this: #3070 was
   * filed after edits that only reverted on the next reload. Cleared by the next SUCCESSFUL
   * save, not by the next keystroke — clearing on edit blanks the message for the debounce
   * window and then brings it back, and an edit that is still unsaved has not stopped being
   * unsaved.
   */
  const deckSaveError: Ref<string | null> = ref(null);

  function scheduleDeckSave(next: MulmoScript): void {
    pendingDeckScript = next;
    if (deckSaveTimer) clearTimeout(deckSaveTimer);
    deckSaveTimer = setTimeout(() => {
      void flushDeckSave();
    }, DECK_SAVE_DEBOUNCE_MS);
  }

  async function flushDeckSave(): Promise<void> {
    deckSaveTimer = null;
    const next = pendingDeckScript;
    pendingDeckScript = null;
    if (!next || !filePath.value) return;
    const response = await api.call("updateScript", { filePath: filePath.value, script: next, origin: EDITOR_ORIGIN });
    if (!response.ok) {
      // The deck editor still holds the latest edit in its props until the next refresh, so
      // the view doesn't snap back on a transient failure — which is why the failure has to be
      // said out loud (#3070). Console too: it is where the existing bug reports start.
      deckSaveError.value = response.error;
      console.error("[presentMulmoScript] deck save failed:", response.error);
      return;
    }
    deckSaveError.value = null;
    commitScript(next);
  }

  function onDeckUpdate(next: DeckScriptShape): void {
    scheduleDeckSave(next as unknown as MulmoScript);
  }

  // Flush synchronously-scheduled work on unmount so a quick switch away
  // doesn't lose the last keystroke. Fire-and-forget — the component is gone,
  // we just want the bytes to land.
  function flushPendingDeckSave(): void {
    if (deckSaveTimer) {
      clearTimeout(deckSaveTimer);
      void flushDeckSave();
    }
  }

  /**
   * Reload when someone else writes this script — the agent, or another window.
   *
   * A pending local edit is flushed first rather than dropped: the user's keystrokes are the
   * thing they would notice losing, and the write that triggered this has already landed, so
   * flushing cannot clobber it out of order.
   */
  function watchForeignWrites(reload: () => void): () => void {
    return api.onScriptChanged({
      filePath: () => filePath.value,
      // Default root until step 2 — see the note in View.vue.
      root: () => undefined,
      ownOrigin: EDITOR_ORIGIN,
      handler: () => {
        flushPendingDeckSave();
        reload();
      },
    });
  }

  return { canEditBeats, deckScriptInput, deckSaveError, onDeckUpdate, flushPendingDeckSave, watchForeignWrites };
}
