// Server-only surface of the remote-host transport: the command loop, the
// connect/disconnect lifecycle, and the Firebase init + auth primitives. Each
// host (MulmoClaude, MulmoTerminal) provides its own handler table, hostId, and
// public Firebase config; everything here is host-agnostic.
//
// The browser-safe protocol (wire types + pure helpers) lives at the parent
// `@mulmoclaude/core/remote-host` so the remote/mobile client can share it
// without pulling this server surface or the Firebase SDK.
export { commandsCollection, hostDoc } from "./paths.js";
export { startHostRunner, DEFAULT_HEARTBEAT_MS, LISTEN_RETRY_WINDOW_MS, presenceStaleAfterMs } from "./hostRunner.js";
export type { HostEvent, HostRunnerOptions } from "./hostRunner.js";
export { PRESENCE_STALE_BEATS } from "./presenceBeat.js";
// The ring outside `startHostRunner`: relaunch the whole runner, and a liveness
// probe so a channel that fails silently is still noticed (#2643).
export { startResilientHostRunner, reconnectDelayMs } from "./resilientRunner.js";
export type { ResilientHostRunnerDeps, CancelTimer } from "./resilientRunner.js";
export { createPresenceProbe, presenceIsFresh, PRESENCE_STALE_MS } from "./presenceProbe.js";
export { withTimeout } from "./withTimeout.js";
export type { Liveness, PresenceProbeDeps } from "./presenceProbe.js";
export { stripUndefined, undefinedPaths, unexpectedPaths } from "./firestoreSafeResult.js";
export { createRemoteHost } from "./lifecycle.js";
export type { RemoteHostStatus, RemoteHostLogger, RemoteHostDeps, RemoteHostLifecycle } from "./lifecycle.js";
export { createRemoteHostAuth } from "./auth.js";
export type { RemoteHostAuth } from "./auth.js";
export { createRemoteHostFirebase, createRemoteHostSession } from "./firebase.js";
export type { RemoteHostFirebase, RemoteHostSession, RemoteHostSessionHandles, RemoteHostSessionValidate } from "./firebase.js";
export { createHostSessionPersistence, isSeedableBlob } from "./sessionPersistence.js";
export type { HostSessionPersistence, HostAuthPersistenceClass, HostAuthPersistenceInstance } from "./sessionPersistence.js";
