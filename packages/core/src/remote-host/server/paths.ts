// Firestore locations of a host's command channel. Server-only: building a
// reference needs the Firebase SDK, and the parent `../index.ts` must load without it.
import { CollectionReference, DocumentData, DocumentReference, Firestore, collection, doc } from "firebase/firestore";
import type { Channel } from "../index.js";

// Per-host command queue: users/{uid}/hosts/{hostId}/commands.
export const commandsCollection = (firestore: Firestore, channel: Channel): CollectionReference<DocumentData> =>
  collection(firestore, "users", channel.uid, "hosts", channel.hostId, "commands");

// Presence doc for a host: users/{uid}/hosts/{hostId}. The host heartbeats
// { online, updatedAt } here; the remote reads it to know if the host is up.
export const hostDoc = (firestore: Firestore, channel: Channel): DocumentReference<DocumentData> =>
  doc(firestore, "users", channel.uid, "hosts", channel.hostId);
