// Optional host-supplied capabilities that are genuinely host TRANSPORT,
// not plugin logic — the browser-side sibling of html-plugin's host-injected
// `previewUrl`. The generic runtime covers JSON dispatch + pubsub; what it
// can't cover is (a) which chat session a generation should be tagged to
// (MulmoClaude's sidebar indicator) and (b) how to fetch movie/PDF bytes,
// which every host serves behind its own auth (MulmoClaude keeps them on
// bearer-guarded /api routes by explicit review decision — see the
// downloadMovie comment trail in the pre-extraction View).
//
// Hosts provide the adapter with Vue's provide() around the View; absent
// capabilities degrade gracefully (no session tagging; download / clip-play
// UI hidden).

import { inject, type InjectionKey, type Ref } from "vue";

export interface MulmoScriptHostAdapter {
  /** Active chat session id, forwarded on generation dispatches so the
   *  host can light its per-session progress indicators. */
  chatSessionId?: Ref<string | undefined>;
  /** Authenticated media download. Exactly one of `moviePath` / `pdfPath`
   *  is set — both are the wire `stories/…` paths the status/probe
   *  dispatches return. Rejects on transport/HTTP failure.
   *
   *  `root` is which registered stories root that path is relative to (#3014); absent = the
   *  host's default. It is REQUIRED for correctness, not decoration: `toStoryRef` relativizes
   *  an artifact against its own root's directory, so the returned path does not carry the
   *  root, and the same `stories/…/__movies__/x.mov` exists in every one of them. A host that
   *  ignores it serves the DEFAULT root's file of that name, or 404s. Optional so an older
   *  host keeps compiling; a single-root host can ignore it because for it the two agree. */
  fetchMediaBlob?: (query: { moviePath?: string; pdfPath?: string; root?: string | undefined }) => Promise<Blob>;
}

export const MULMOSCRIPT_HOST_ADAPTER_KEY: InjectionKey<MulmoScriptHostAdapter> = Symbol("mulmoscript-host-adapter");

const EMPTY_ADAPTER: MulmoScriptHostAdapter = {};

export function useHostAdapter(): MulmoScriptHostAdapter {
  return inject(MULMOSCRIPT_HOST_ADAPTER_KEY, EMPTY_ADAPTER);
}
