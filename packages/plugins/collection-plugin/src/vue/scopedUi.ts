// Per-card scoping of the host binding.
//
// `configureCollectionUi` installs ONE global binding, and in a multi-root host
// that binding resolves every request against whatever project is ambient — the
// pane the user is looking at. A chat card, though, was made in a particular
// project: its payload carries `PresentCollectionData.scope` (host-stamped,
// never model-supplied). Without reading it, a card built in project A fetches
// project B's records the moment the ambient project moves.
//
// So a card provides its scope to its own subtree, and every component reads the
// binding through `useCollectionUi()` instead of `collectionUi()`. Outside a
// scoped subtree — the standalone Collections page, a host with no `withScope` —
// this resolves to exactly the global binding, so a single-workspace host
// (MulmoClaude) behaves identically.

import { inject, provide, type InjectionKey } from "vue";
import { collectionUi, type CollectionUi } from "./uiContext";

/** A card subtree's binding resolver. Read as a getter rather than a value so
 *  a card whose payload changes (the chat selects another result) re-resolves
 *  instead of holding the binding it was mounted with. */
type ScopedUiGetter = () => CollectionUi;

const SCOPED_UI: InjectionKey<ScopedUiGetter> = Symbol("collectionScopedUi");

/** One binding per base binding and scope, so re-resolving on every property read
 *  doesn't hand out a fresh object each time (a host builds its scoped binding
 *  eagerly). Keyed by the base too: two subtrees bound to different servers can
 *  hold the same project id. */
// Weak on the base, so a host's binding for a server nobody shows any more is released with
// everything built from it. Reassigned only by the test reset, since a WeakMap cannot be cleared.
let bindings = new WeakMap<CollectionUi, Map<string, CollectionUi>>();

/** Test-only: drop the memoised scoped bindings (a test reconfigures the host). */
export function resetScopedCollectionUi(): void {
  bindings = new WeakMap();
}

/** Resolve the binding for one scope, built from `base` — the binding a host put
 *  around this subtree, or the global one. Exported for tests: this is the whole
 *  decision — a scope plus a base that does projects yields a scoped binding,
 *  anything else yields the base itself. */
export function resolveScopedCollectionUi(scope: string | undefined, base: CollectionUi = collectionUi()): CollectionUi {
  // No scope, or a base that doesn't do projects: the base, unchanged.
  if (scope === undefined || base.withScope === undefined) return base;
  const perBase = bindings.get(base) ?? new Map<string, CollectionUi>();
  bindings.set(base, perBase);
  const cached = perBase.get(scope);
  if (cached !== undefined) return cached;
  const built = base.withScope(scope);
  perBase.set(scope, built);
  return built;
}

/** Bind a subtree to a binding of the host's own — a card whose requests go to
 *  another server than the global binding's. Call from setup, ABOVE the card: the
 *  card's own `provideCollectionScope` then scopes this binding rather than the
 *  global one. The getter should return the same object for the same target, so
 *  the scoped bindings built from it are reused. */
// The plugin's display language (`localeTag`) and its starter-card translation (`translate`)
// stay on the global binding: they belong to the person looking, not to the server a card reads.
export function provideCollectionUi(binding: () => CollectionUi): void {
  provide(SCOPED_UI, binding);
}

/** Bind this component's subtree to the project a card was made in. Call from
 *  setup; `scope` is read lazily so a reactive source stays live. The project is
 *  scoped on the binding around this component — the host's, when it provided
 *  one with `provideCollectionUi`, or the global one. */
export function provideCollectionScope(scope: () => string | undefined): void {
  const outer = inject(SCOPED_UI, null) ?? collectionUi;
  provide(SCOPED_UI, () => resolveScopedCollectionUi(scope(), outer()));
}

/** The host binding for this component — the card's scoped one inside a scoped
 *  subtree, the global one everywhere else. Call from setup; the returned object
 *  forwards each read to the binding current at that moment, so it is safe to
 *  capture once and use in async handlers. */
/** The binding RESOLVER for this component — the same choice as
 *  {@link useCollectionUi}, deferred. Call from setup, then call the result
 *  wherever the binding is actually needed: nothing touches the host binding
 *  until then, which keeps a composable usable before a host has configured one
 *  (the shape its unit tests rely on). */
export function useCollectionUiGetter(): () => CollectionUi {
  return inject(SCOPED_UI, null) ?? collectionUi;
}

export function useCollectionUi(): CollectionUi {
  const getter = inject(SCOPED_UI, null);
  if (getter === null) return collectionUi();
  // Read-through rather than a snapshot: a card whose payload changes under it
  // (the chat selects another result) must not keep the binding it mounted
  // with. The target is the global binding so this is a real CollectionUi; the
  // trap replaces every read. Both hosts' bindings are plain closures, so a
  // forwarded method needs no `this`.
  return new Proxy(collectionUi(), {
    get(_target, prop) {
      const value: unknown = Reflect.get(getter(), prop);
      return value;
    },
    has(_target, prop) {
      return Reflect.has(getter(), prop);
    },
  });
}
