// A custom Firebase Auth persistence that keeps the signed-in session in memory
// but can be seeded from — and exported back to — an opaque blob, so a host's
// Firebase session survives a process restart by being parked in the browser's
// localStorage (mulmoserver#50, "case A'"). The blob is whatever the SDK wrote
// into persistence, round-tripped through JSON; we never interpret its VALUES,
// so we don't couple to the SDK's serialized-user format across versions. Key
// NAMES we do read, but only their app-name segment — see `seed`.
//
// **Persistence is a CLASS, not an instance.** `initializeAuth(app, { persistence })`
// hands the value to the SDK's `_getInstance(cls)`, which asserts `cls instanceof
// Function` ("Expected a class definition") and then `new cls()`. Passing a plain
// object throws — the SDK's own `inMemoryPersistence` is likewise a class. The
// class is defined per factory call so its instances share this call's store;
// `type: "LOCAL"` makes the SDK treat it as durable and persist the user.
//
// Seed BEFORE `initializeAuth` — the SDK reads persistence once at init. `onChange`
// fires when the SDK writes/removes a key (a token update that rotates the stored
// blob, or a sign-out) — the signal to re-sync the browser copy.
import type { Persistence } from "firebase/auth";

// The SDK stores values as JSON objects (a serialized user) or strings. We treat
// them opaquely — a value is either.
type PersistenceValue = Record<string, unknown> | string;

type StorageListener = (value: PersistenceValue | null) => void;

// The instance the SDK builds via `new` and then drives with these `_`-methods.
export interface HostAuthPersistenceInstance extends Persistence {
  type: "LOCAL";
  _isAvailable: () => Promise<boolean>;
  _set: (key: string, value: PersistenceValue) => Promise<void>;
  _get: (key: string) => Promise<PersistenceValue | null>;
  _remove: (key: string) => Promise<void>;
  _addListener: (key: string, listener: StorageListener) => void;
  _removeListener: (key: string, listener: StorageListener) => void;
}

// The class value passed to `initializeAuth`. The static `type` makes it
// assignable to the SDK's `Persistence` (a class-valued-typed-as-instance, the
// same trick the SDK uses for `inMemoryPersistence`); `new ()` lets the SDK — and
// the tests — instantiate it.
export interface HostAuthPersistenceClass extends Persistence {
  type: "LOCAL";
  new (): HostAuthPersistenceInstance;
}

export interface HostSessionPersistence {
  /** Pass to `initializeAuth(app, { persistence })`. It's a class the SDK `new`s. */
  persistence: HostAuthPersistenceClass;
  /**
   * Load a previously exported blob. Call BEFORE `initializeAuth`. `appName`
   * re-keys the blob for the app about to be opened (see `rekeyForApp`); omit
   * it to restore keys verbatim, which is what a rollback to a still-live app
   * needs.
   */
  seed: (blob: string, appName?: string) => void;
  /** Serialize the current contents, or `null` when empty (no session). */
  exportBlob: () => string | null;
  /** Notified with the fresh blob (or `null`) whenever the SDK writes/removes. */
  onChange: (listener: (blob: string | null) => void) => () => void;
  /** Drop all contents (used when tearing down the Firebase app). */
  clear: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isPersistenceValue = (value: unknown): value is PersistenceValue => typeof value === "string" || isRecord(value);

// True when `blob` is a JSON object `seed` can load. A blob that fails this can
// never restore a session (corrupt localStorage, wrong shape), so callers treat
// it as an expired/invalid session rather than a transient error — the client
// then drops it instead of retrying the same doomed blob forever.
export const isSeedableBlob = (blob: string): boolean => {
  try {
    return isRecord(JSON.parse(blob));
  } catch {
    return false;
  }
};

// Firebase Auth namespaces every persistence key with the app that wrote it:
// `firebase:<key>:<apiKey>:<appName>` (@firebase/auth's `_persistenceKeyName`).
// A host opens a fresh app per connect, so a blob parked while `remote-host-2`
// was live is invisible to the `remote-host-1` app a restarted host opens first
// — the SDK looks up its own key, misses, and settles with no user (#3089).
// Rewriting the app-name segment as the blob is seeded makes a parked session
// independent of the sequence number it happened to be saved under. Only the key
// is touched: the serialized user stays opaque, and its own `appName` field is
// never read back by the SDK (`UserImpl._fromJSON`, @firebase/auth 1.13.3).
// A key of any other shape is passed through untouched.
const FIREBASE_KEY_NAMESPACE = "firebase";
const FIREBASE_KEY_SEGMENTS = 4;

const rekeyForApp = (key: string, appName: string): string => {
  const segments = key.split(":");
  if (segments.length !== FIREBASE_KEY_SEGMENTS || segments[0] !== FIREBASE_KEY_NAMESPACE) return key;
  return [...segments.slice(0, FIREBASE_KEY_SEGMENTS - 1), appName].join(":");
};

// A class (constructor) so the SDK's `_getInstance` accepts it (it asserts
// `cls instanceof Function`, then `new cls()`); instances hold the shared
// `store`/`notify`, so a fresh `new` still sees the seeded/live data. `static
// type` is for the `Persistence` type bridge; the instance `type` is what the
// SDK reads after `new`.
const makeHostPersistenceClass = (store: Map<string, PersistenceValue>, notify: () => void): HostAuthPersistenceClass => {
  class HostAuthPersistence {
    static readonly type = "LOCAL" as const;
    readonly type = "LOCAL" as const;
    private readonly store = store;
    private readonly notify = notify;
    private readonly external = new Set<StorageListener>();
    _isAvailable(): Promise<boolean> {
      return Promise.resolve(this.store instanceof Map);
    }
    async _set(key: string, value: PersistenceValue): Promise<void> {
      this.store.set(key, value);
      this.notify();
    }
    _get(key: string): Promise<PersistenceValue | null> {
      return Promise.resolve(this.store.get(key) ?? null);
    }
    async _remove(key: string): Promise<void> {
      this.store.delete(key);
      this.notify();
    }
    // Node has no cross-tab storage events to deliver, so registered listeners
    // never fire; we still track them so add/remove stay symmetric.
    _addListener(_key: string, listener: StorageListener): void {
      this.external.add(listener);
    }
    _removeListener(_key: string, listener: StorageListener): void {
      this.external.delete(listener);
    }
  }
  return HostAuthPersistence;
};

export const createHostSessionPersistence = (): HostSessionPersistence => {
  const store = new Map<string, PersistenceValue>();
  const listeners = new Set<(blob: string | null) => void>();

  const exportBlob = (): string | null => (store.size === 0 ? null : JSON.stringify(Object.fromEntries(store)));

  const notify = (): void => {
    const blob = exportBlob();
    listeners.forEach((listener) => listener(blob));
  };

  const persistence = makeHostPersistenceClass(store, notify);

  const seed = (blob: string, appName?: string): void => {
    const parsed: unknown = JSON.parse(blob);
    if (!isRecord(parsed)) throw new Error("host session blob must be a JSON object");
    store.clear();
    for (const [key, value] of Object.entries(parsed)) {
      if (isPersistenceValue(value)) store.set(appName ? rekeyForApp(key, appName) : key, value);
    }
  };

  const onChange = (listener: (blob: string | null) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const clear = (): void => {
    store.clear();
  };

  return { persistence, seed, exportBlob, onChange, clear };
};
