// Firebase init for a remote-host runner.
//
// A host acts as a *host*: it signs in to Firebase as the user (via
// signInWithCredential, see auth.ts) and listens to that user's command queue in
// Firestore. The modular firebase/firestore + firebase/auth SDKs run in Node, so
// this mirrors a browser init but also exposes Firestore (default database,
// which must be in Native mode) and Storage.
//
// Extracted into core from MulmoClaude's server/remoteHost/firebase.ts. The
// public web config is a parameter so each host supplies its own (both hosts
// reuse the shared mulmoserver project).
import { deleteApp, FirebaseApp, FirebaseOptions, initializeApp } from "firebase/app";
import { Auth, getAuth, initializeAuth } from "firebase/auth";
import { Firestore, getFirestore } from "firebase/firestore";
import { FirebaseStorage, getStorage } from "firebase/storage";

import { createHostSessionPersistence, type HostSessionPersistence } from "./sessionPersistence.js";

export interface RemoteHostFirebase {
  app: FirebaseApp;
  auth: Auth;
  firestore: Firestore;
  // Storage carries the full-res attachment bytes the command channel can't (a
  // Firestore command doc caps at ~1 MiB). The host, signed in as the user,
  // pulls each staged upload from `users/{uid}/uploads/{id}` and deletes it
  // after ingest.
  storage: FirebaseStorage;
}

export const createRemoteHostFirebase = (config: FirebaseOptions): RemoteHostFirebase => {
  const app = initializeApp(config);
  return { app, auth: getAuth(app), firestore: getFirestore(app), storage: getStorage(app) };
};

export interface RemoteHostSessionHandles {
  auth: Auth;
  firestore: Firestore;
  storage: FirebaseStorage;
  // The signed-in uid restored from a seed blob, or null when opened fresh
  // (before `signInHost`) or when the blob held no valid session.
  uid: string | null;
}

// A restartable Firebase session for a host, backed by the export/seed-able
// persistence (mulmoserver#50, "case A'"). Because `initializeAuth` reads
// persistence once and can run only once per app, each `open` spins up a FRESH
// app (unique name) with the persistence seeded first, then tears down the
// previous app — so a reconnect can restore a browser-parked session, and a
// fresh connect starts clean. `exportSession`/`onSessionChange` expose the blob
// the browser stores and the signal to re-sync it.
// Runs on the freshly opened handles BEFORE the previous session is torn down.
// Reject to keep the open non-destructive: the fresh app is rolled back and the
// previous session is preserved (so a failed sign-in or an expired blob doesn't
// replace a healthy live session).
export type RemoteHostSessionValidate = (handles: RemoteHostSessionHandles) => Promise<void>;

export interface RemoteHostSession {
  open: (seedBlob?: string, validate?: RemoteHostSessionValidate) => Promise<RemoteHostSessionHandles>;
  close: () => Promise<void>;
  exportSession: () => string | null;
  onSessionChange: (cb: (blob: string | null) => void) => () => void;
}

const noop = (): void => undefined;

// Run operations one-at-a-time in submission order. `open`/`close` mutate shared
// store/app state, so overlapping calls must not interleave (they would leak an
// app or leave `app` pointing at a torn-down instance). Mirrors the lifecycle's
// serialization; a failed op doesn't block the next.
const makeSerializer = () => {
  let transition: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const next = transition.then(operation, operation);
    transition = next.then(noop, noop);
    return next;
  };
};

// Build a fresh app from the (already seeded) persistence and wait for the
// restored auth state to settle. Persistence restore is async, so `uid`
// reflects a seeded session only after `authStateReady()` (null when the blob
// was empty/invalid, or on a fresh connect before `signInHost`).
const openFreshApp = async (
  config: FirebaseOptions,
  store: HostSessionPersistence,
  name: string,
): Promise<{ app: FirebaseApp; handles: RemoteHostSessionHandles }> => {
  // `initializeApp` registers the app in the SDK's global registry, so if init
  // then throws we must delete it — otherwise repeated reconnect failures leak
  // a registered app each time.
  const app = initializeApp(config, name);
  try {
    const auth = initializeAuth(app, { persistence: store.persistence });
    await auth.authStateReady();
    return { app, handles: { auth, firestore: getFirestore(app), storage: getStorage(app), uid: auth.currentUser?.uid ?? null } };
  } catch (error) {
    await deleteApp(app).catch(() => undefined);
    throw error;
  }
};

export const createRemoteHostSession = (config: FirebaseOptions): RemoteHostSession => {
  const store = createHostSessionPersistence();
  let app: FirebaseApp | null = null;
  let appSeq = 0;
  const serialize = makeSerializer();

  const closeInner = async (): Promise<void> => {
    const previous = app;
    app = null;
    store.clear();
    if (previous) await deleteApp(previous);
  };

  // Run the caller's check on the fresh handles; on rejection, delete the fresh
  // app so only the caller-visible error escapes and the previous session (never
  // touched here) stays live.
  const validateOrRollback = async (nextApp: FirebaseApp, handles: RemoteHostSessionHandles, validate?: RemoteHostSessionValidate): Promise<void> => {
    if (!validate) return;
    try {
      await validate(handles);
    } catch (error) {
      await deleteApp(nextApp).catch(() => undefined);
      throw error;
    }
  };

  const openInner = async (seedBlob?: string, validate?: RemoteHostSessionValidate): Promise<RemoteHostSessionHandles> => {
    // Non-destructive: keep the current session intact until the fresh app is
    // proven to come up AND pass `validate` (sign-in / uid). A bad seed blob, a
    // failed init, or a rejected validation must not tear down a healthy session
    // — the reconnect contract (mulmoserver#50). So we tear the previous app
    // down only AFTER success, and roll the store back on failure.
    const previousApp = app;
    const previousBlob = store.exportBlob();
    appSeq += 1;
    // `appSeq` restarts at 0 each process and counts failed opens too, so the
    // name a blob was parked under is meaningless to a later run. `seed` re-keys
    // the blob to the app we are opening now, which is what makes a parked
    // session restorable at all (#3089).
    const appName = `remote-host-${appSeq}`;
    try {
      store.clear();
      if (seedBlob) store.seed(seedBlob, appName);
      const { app: nextApp, handles } = await openFreshApp(config, store, appName);
      await validateOrRollback(nextApp, handles, validate);
      app = nextApp;
      if (previousApp) await deleteApp(previousApp).catch(() => undefined);
      return handles;
    } catch (error) {
      // Verbatim: the previous app is still live and reads the keys the blob
      // already carries, so re-keying here would hide its own session from it.
      store.clear();
      if (previousBlob) store.seed(previousBlob);
      throw error;
    }
  };

  return {
    open: (seedBlob?: string, validate?: RemoteHostSessionValidate) => serialize(() => openInner(seedBlob, validate)),
    close: () => serialize(closeInner),
    exportSession: store.exportBlob,
    onSessionChange: store.onChange,
  };
};
