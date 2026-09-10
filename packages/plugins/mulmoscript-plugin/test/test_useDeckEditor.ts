import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computed } from "vue";
import { useDeckEditor, type DeckEditorTransport } from "../src/vue/composables/useDeckEditor";
import type { TransportResult } from "../src/vue/transport";
import type { MulmoScript } from "../src/vue/viewTypes";

/**
 * A deck save that fails has to say so (#3070).
 *
 * The editor keeps showing the user's edit whether the write landed or not — deliberately, so a
 * transient failure doesn't eat keystrokes. That makes "saved" and "silently refused" look
 * identical on screen until the next reload puts the old value back, which is how edits were
 * lost. What is pinned here is the lifecycle of the message, not its wording.
 */

type SaveOutcome = TransportResult<Record<string, never>>;
const OK: SaveOutcome = { ok: true, data: {} };
const failedWith = (error: string): SaveOutcome => ({ ok: false, error });

/** The debounce is 300ms; every test drives `flushPendingDeckSave` rather than waiting it out. */
function harness(outcomes: SaveOutcome[]) {
  const script: MulmoScript = { title: "deck", beats: [{ text: "one" }] };
  const committed: MulmoScript[] = [];
  const sentTitles: (string | undefined)[] = [];

  const api: DeckEditorTransport = {
    call: async (_kind, args) => {
      sentTitles.push(args.script.title);
      const outcome = outcomes.shift();
      assert.ok(outcome, "the test queued an outcome for every save it lets fly");
      return outcome;
    },
    onScriptChanged: () => () => {},
  };

  const editor = useDeckEditor({
    api,
    filePath: computed(() => "stories/deck/launch.json"),
    effectiveScript: computed(() => script),
    commitScript: (next) => committed.push(next),
  });

  /** Let any armed debounce fire and the write settle. `setImmediate` runs after microtasks. */
  async function settle(): Promise<void> {
    editor.flushPendingDeckSave();
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function edit(title: string): Promise<void> {
    editor.onDeckUpdate({ title, beats: [{ text: "one" }] });
    await settle();
  }

  return { ...editor, edit, settle, committed, sentTitles };
}

describe("a deck save that failed", () => {
  it("starts with nothing to report", () => {
    const { deckSaveError } = harness([]);
    assert.equal(deckSaveError.value, null);
  });

  it("keeps the server's own words, and does not commit the edit", async () => {
    const { deckSaveError, edit, committed } = harness([failedWith("File not found: stories/deck/launch.json")]);
    await edit("renamed");
    assert.equal(deckSaveError.value, "File not found: stories/deck/launch.json");
    assert.deepEqual(committed, []);
  });

  it("stays put while the next edit is only pending — an unsaved edit has not become saved", async () => {
    const { deckSaveError, onDeckUpdate, edit, settle } = harness([failedWith("EACCES: permission denied"), OK]);
    await edit("renamed");
    onDeckUpdate({ title: "renamed again" });
    assert.equal(deckSaveError.value, "EACCES: permission denied");
    await settle();
  });

  it("clears once a save actually lands, and that one commits", async () => {
    const { deckSaveError, edit, committed } = harness([failedWith("File not found"), OK]);
    await edit("renamed");
    assert.equal(deckSaveError.value, "File not found");
    await edit("renamed again");
    assert.equal(deckSaveError.value, null);
    assert.deepEqual(
      committed.map((script) => script.title),
      ["renamed again"],
    );
  });

  it("is replaced, not added to, when a second save fails differently", async () => {
    const { deckSaveError, edit } = harness([failedWith("File not found"), failedWith("ETIMEDOUT")]);
    await edit("renamed");
    await edit("renamed again");
    assert.equal(deckSaveError.value, "ETIMEDOUT");
  });
});

describe("a deck save that succeeds", () => {
  it("never puts a message on screen", async () => {
    const { deckSaveError, edit, committed, sentTitles } = harness([OK, OK]);
    await edit("one");
    await edit("two");
    assert.equal(deckSaveError.value, null);
    assert.deepEqual(sentTitles, ["one", "two"]);
    assert.equal(committed.length, 2);
  });
});

/**
 * The View is where the message becomes visible. Read from source rather than mounted: mounting
 * it needs a gui-chat-protocol runtime, a transport and a host adapter to assert one element.
 */
describe("the View's save-failure banner", () => {
  const viewSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "vue", "View.vue"), "utf-8");

  it("takes deckSaveError off the composable", () => {
    assert.match(viewSource, /const \{[^}]*\bdeckSaveError\b[^}]*\} = useDeckEditor\(/);
  });

  it("renders it as an alert carrying the server's message", () => {
    assert.match(viewSource, /data-testid="mulmo-script-deck-save-error"/);
    assert.match(viewSource, /v-if="deckSaveError"/);
    assert.match(viewSource, /m\.saveErrorSaveFailed\(deckSaveError\)/);
  });

  it("is not gated on the Edit pane — switching tabs does not make the edit saved", () => {
    const banner = /<div\s+v-if="deckSaveError"[\s\S]*?<\/div>/.exec(viewSource);
    assert.ok(banner, "the banner block is found");
    assert.doesNotMatch(banner[0], /showBeatEditor|beatPane/);
    assert.match(banner[0], /role="alert"/);
  });
});
