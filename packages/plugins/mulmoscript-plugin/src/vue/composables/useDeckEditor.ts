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
   * filed after edits that only reverted on the next reload. Within one script the only thing
   * that clears it is the next SUCCESSFUL save — never the next keystroke, which would blank
   * the message for the debounce window and then bring it back, and an edit that is still
   * unsaved has not stopped being unsaved. Leaving the script clears it too, for a different
   * reason: see `resetForScriptChange`.
   */
  const deckSaveError: Ref<string | null> = ref(null);

  /**
   * Which edit the in-flight save is answering for.
   *
   * Advanced when an edit is QUEUED, not when its save is dispatched — those are up to 300ms
   * apart, and a write can outlive the gap (the failing kind is the slow kind: a timeout costs
   * the whole budget). An answer about superseded content must not be acted on either way
   * round: committing it puts the older script back over what the user is typing, and its
   * verdict is about text that is no longer on screen — a green light for an edit that never
   * reached the server, or a red banner for one already replaced.
   */
  let editRevision = 0;

  function scheduleDeckSave(next: MulmoScript): void {
    pendingDeckScript = next;
    editRevision += 1;
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
    const revision = editRevision;
    const response = await api.call("updateScript", { filePath: filePath.value, script: next, origin: EDITOR_ORIGIN });
    if (revision !== editRevision) return;
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

  /**
   * The script this composable was editing is gone — the View moved to a different result, or
   * this one was rewritten whole by another route.
   *
   * Clearing the banner is not enough, because this View re-initializes in place rather than
   * remounting (`watch(() => props.selectedResult, initializeScript)`), so everything the old
   * script left behind survives the switch and lands on the new one:
   *
   * - an answer still IN FLIGHT would repopulate the banner, or commit the old script into the
   *   new result — its revision is still current, since no new edit has been queued;
   * - an edit still QUEUED would be written out by its own timer against `filePath.value`,
   *   which by then names the NEW file. That one writes one deck's beats into another deck.
   *
   * So the revision advances (every in-flight answer becomes stale) and the queue is dropped.
   * The per-beat errors beside this are reset the same way, in the same function.
   */
  function resetForScriptChange(): void {
    if (deckSaveTimer) clearTimeout(deckSaveTimer);
    deckSaveTimer = null;
    pendingDeckScript = null;
    editRevision += 1;
    deckSaveError.value = null;
  }

  return { canEditBeats, deckScriptInput, deckSaveError, resetForScriptChange, onDeckUpdate, flushPendingDeckSave, watchForeignWrites };
}
