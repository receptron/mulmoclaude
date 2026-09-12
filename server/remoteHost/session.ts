// Firebase session for this host's remote-host runner, backed by the export/
// seed-able session controller in `@mulmoclaude/core/remote-host/server` so a
// server restart doesn't drop the session — the browser parks it in
// localStorage and hands it back on reconnect (case A', mulmoserver#50).
//
// The controller opens a FRESH Firebase app per (re)connect (initializeAuth
// reads persistence once), so `auth`/`firestore`/`storage` change each time.
// This module holds the current handles and exposes them as getters, so the
// runner, onExpire, and attachment ingest always target the live session's
// Firestore/Storage/uid rather than a stale module-level instance.
import { createRemoteHostAuth, createRemoteHostSession, isSeedableBlob, type RemoteHostSessionHandles } from "@mulmoclaude/core/remote-host/server";
import type { Firestore } from "firebase/firestore";
import type { FirebaseStorage } from "firebase/storage";

import { firebaseConfig } from "../../src/config/firebaseConfig.js";

const session = createRemoteHostSession(firebaseConfig);
let handles: RemoteHostSessionHandles | null = null;

// A parked blob that Firebase restored to no valid user (expired refresh token,
// revoked session). Distinct from transient/init failures so the route can
// answer 401 (client drops the blob) instead of 5xx (client keeps it).
export class RemoteHostSessionExpiredError extends Error {
  constructor() {
    super("remote-host session could not be restored");
    this.name = "RemoteHostSessionExpiredError";
  }
}

const uidOf = (opened: RemoteHostSessionHandles): string => {
  const uid = opened.auth.currentUser?.uid;
  if (!uid) throw new Error("remote-host session opened without an authenticated user");
  return uid;
};

// Fresh connect: open a clean session and sign in with the browser-minted Google
// OAuth ID token. The sign-in runs as the session's `validate` step, so a bad
// token rolls the fresh app back and leaves any live session untouched. Resolves
// to the authenticated uid.
export const signIn = async (idToken: string): Promise<string> => {
  const next = await session.open(undefined, async (opened) => {
    await createRemoteHostAuth(opened.auth).signInHost(idToken);
  });
  handles = next;
  return uidOf(next);
};

// Popup-free reconnect: open the session seeded from the browser-parked blob,
// validating (before any teardown) that it restored a real user. Both a
// malformed blob and one that yields no user reject with
// RemoteHostSessionExpiredError — neither can ever restore a session, so the
// client is told (401) to drop it; genuine transient failures propagate as-is
// (5xx, blob kept). Reconnect stays non-destructive either way.
export const restore = async (blob: string): Promise<string> => {
  if (!isSeedableBlob(blob)) throw new RemoteHostSessionExpiredError();
  const next = await session.open(blob, (opened) => (opened.uid ? Promise.resolve() : Promise.reject(new RemoteHostSessionExpiredError())));
  handles = next;
  return uidOf(next);
};

// Tear the local session down even if the Firebase sign-out throws: otherwise
// `handles`/`currentUid` would stay stale and the app would leak while the route
// answered 500. The sign-out error still propagates after cleanup.
export const signOut = async (): Promise<void> => {
  try {
    if (handles) await createRemoteHostAuth(handles.auth).signOutHost();
  } finally {
    handles = null;
    await session.close();
  }
};

const requireHandles = (): RemoteHostSessionHandles => {
  if (!handles) throw new Error("remote-host session is not open");
  return handles;
};

export const currentUid = (): string | null => handles?.auth.currentUser?.uid ?? null;
// The Google display name, as the gallery shows an author. Empty when the
// account has none; null when there is no session at all.
export const currentDisplayName = (): string | null => (handles?.auth.currentUser ? (handles.auth.currentUser.displayName ?? "") : null);
export const currentFirestore = (): Firestore => requireHandles().firestore;
export const currentStorage = (): FirebaseStorage => requireHandles().storage;

// Non-throwing twin of `currentFirestore`, for consumers that must treat "no
// session" as an ordinary state rather than an exception — shared collections
// ask on every operation, including from screens that merely LIST collections,
// so a throw would break unrelated UI.
//
// The EMAIL is the principal the deployed Firestore rules authorize on
// (`apps/{aid}.members` is keyed by email), and it is what every record
// operation resolves a role with. A session whose user has no email is not
// usable for a shared collection, so it is reported as no session at all
// rather than as a session that will be refused document by document.
//
// The uid rides along for `publish` alone: the app document's `owner` is a uid
// (`owner == request.auth.uid` on create, unchanged thereafter), so creating
// an app needs an identity the roster never mentions. Both are required — a
// session missing either cannot do the whole job, and reporting a half-usable
// session would move the failure to a permission denial that says nothing.
export const currentFirestoreSession = (): { firestore: Firestore; email: string; uid: string } | null => {
  const email = handles?.auth.currentUser?.email;
  const uid = handles?.auth.currentUser?.uid;
  return handles && email && uid ? { firestore: handles.firestore, email, uid } : null;
};

// The signed-in user's Firebase ID token, or null when the RemoteHost session
// isn't open / not authenticated. web-push uses this to authenticate `sendPush`;
// a null result (RemoteHost disconnected) makes the push a silent no-op. The
// caller (@mulmobridge/web-push) treats a thrown/rejected token the same as null.
export const currentIdToken = (): Promise<string | null> => {
  const user = handles?.auth.currentUser;
  return user ? user.getIdToken() : Promise.resolve(null);
};

// The blob the browser parks (refresh token included). Null when disconnected.
export const exportSession = (): string | null => session.exportSession();
