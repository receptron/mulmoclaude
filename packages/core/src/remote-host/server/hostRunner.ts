// Host side of the command channel: claim queued commands, run handlers, write
// results back, and announce presence via heartbeat.
//
// Extracted into core from MulmoClaude's server/remoteHost/hostRunner.ts (itself
// ported from ../mulmoserver). The only signature change vs. that copy: the
// `firestore` instance is a parameter (each host supplies its own Firebase init),
// and the heartbeat interval is an option (defaults to one minute).
import {
  DocumentReference,
  Firestore,
  FirestoreError,
  Query,
  QuerySnapshot,
  deleteDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

import { isRecord } from "@mulmoclaude/common";

import { errorMessage } from "../../collection/core/errorMessage.js";
import { Channel, Command, CommandHandler, CommandHandlers, HostMachine, buildHostPresence, byCreatedAt, coerceJsonObject, isExpired } from "../index.js";
import { commandsCollection, hostDoc } from "./paths.js";
import { stripUndefined, undefinedPaths, unexpectedPaths } from "./firestoreSafeResult.js";
import { PRESENCE_STALE_BEATS, createPresenceBeat, type PresenceBeat } from "./presenceBeat.js";
import { monotonicNowMs } from "./monotonicClock.js";
// Listener retry policy: `../../firestore/listen.ts`. It is true of ANY
// Firestore listener, and the shared-collection store has one too. Two copies
// would drift SILENTLY — one subsystem retrying a revoked grant forever while
// the other gives up on a network blip.
import { backoffDelayMs, classifyListenerError, LISTEN_RETRY_WINDOW_MS, shouldGiveUpListening } from "../../firestore/listen.js";

// Exported so a host that judges presence freshness from the outside (a probe that
// reads the doc back) measures against the same beat the runner writes on.
export const DEFAULT_HEARTBEAT_MS = 60_000;

// Re-exported under their original names so this module's published surface —
// which MulmoTerminal imports — is unchanged by the move.
export { backoffDelayMs, classifyListenerError, LISTEN_RETRY_WINDOW_MS, shouldGiveUpListening };

export interface HostEvent {
  phase: "received" | "done" | "error";
  method: string;
  message?: string;
}

export interface HostRunnerOptions {
  onEvent?: (event: HostEvent) => void;
  // Called once when the listener dies fatally (after presence has been set
  // offline), so the lifecycle owner can reconcile its own state — e.g. clear
  // the runner handle so status() no longer reports connected. NOT called on a
  // normal stop().
  onClosed?: () => void;
  // Called when a command is dropped for being past its `expiresAt`, BEFORE the
  // doc is deleted, so the host can clean up out-of-band resources the command
  // referenced (e.g. staged attachment uploads in Storage). `uid` is THIS runner's
  // session uid (channel.uid) — passed in rather than read from a global so a
  // concurrent reconnect as a different account can't point cleanup at the wrong
  // user's Storage path. Best-effort: a throw is logged via onEvent and does NOT
  // block the doc deletion. Absent ⇒ the expired doc is simply deleted.
  onExpire?: ((command: Command, uid: string) => void | Promise<void>) | undefined;
  // Presence heartbeat interval; defaults to one minute.
  heartbeatMs?: number | undefined;
  // Paths in a handler's reply where `undefined` is expected rather than a bug,
  // keyed by method name — `{ listSessions: ["sessions.*.work"] }`, `*` matching
  // exactly one segment. Firestore refuses `undefined` either way, so these are
  // still stripped; declaring them only silences the report, which is what keeps
  // it worth reading (#2634).
  expectedUndefined?: Record<string, readonly string[]>;
  // Written into every presence beat so the remote can tell one machine of this host
  // from another. Absent ⇒ the presence carries no machine fields.
  machine?: HostMachine | undefined;
}

export interface Claim {
  method: string;
  // Still unproved JSON here: the doc is remote-written, so the walk that earns
  // `JsonObject` runs at the handler boundary, outside the claim transaction.
  params: Record<string, unknown>;
}

const noop = () => undefined;

// The remote may have deleted the doc on timeout, so ignore write-after-delete.
const writeError = (ref: DocumentReference, code: string, message: string) =>
  updateDoc(ref, { status: "error", error: { code, message }, updatedAt: serverTimestamp() }).catch(noop);

// What a queued command doc contributes to a claim, rebuilt from the two
// members that were checked rather than asserted off a `DocumentData`.
// `null` means "not ours to take" — the doc is gone or someone else moved it
// out of `queued`.
//
// Anything else DEGRADES instead of bailing: a non-string method becomes "" so
// the dispatch falls through to the unknown-method reply, and non-object params
// become an empty set so the handler's own required-field check answers. Both
// write an error back to the doc. Returning null for them instead would leave
// the command claimed as `processing` with nothing ever written back — the one
// outcome the remote cannot distinguish from a dead host.
export const readClaim = (data: unknown): Claim | null => {
  if (!isRecord(data) || data.status !== "queued") return null;
  return { method: typeof data.method === "string" ? data.method : "", params: isRecord(data.params) ? data.params : {} };
};

// Atomically move a command queued -> processing so it is handled exactly once.
// Returns the method/params to run, or null if another handler already took it.
const claimCommand = (firestore: Firestore, ref: DocumentReference): Promise<Claim | null> =>
  runTransaction(firestore, async (txn) => {
    const claim = readClaim((await txn.get(ref)).data());
    if (!claim) {
      return null;
    }
    txn.update(ref, { status: "processing", updatedAt: serverTimestamp() });
    return claim;
  });

// Own-property lookup: a bare `handlers[method]` with a method name written by a
// remote terminal resolves `constructor` / `toString` to an Object.prototype
// function, which is truthy and slips past the unknown-method check (#2319).
export const resolveCommandHandler = (handlers: CommandHandlers, method: string): CommandHandler | undefined =>
  Object.hasOwn(handlers, method) ? handlers[method] : undefined;

// Firestore refuses a write containing `undefined` at any depth, so one stray
// value would cost the whole reply — `status: "done"` never lands and the remote
// waits out its timeout. Strip instead, and name the paths: Firestore's own error
// points at the document, never at the field, which is where the debugging time
// goes. Paths the caller declared as legitimately-optional are stripped silently.
const reportStripped = (dropped: string[], claim: Claim, options: HostRunnerOptions): void => {
  if (dropped.length === 0) return;
  const paths = dropped.map((path) => `result.${path}`).join(", ");
  options.onEvent?.({ phase: "error", method: claim.method, message: `undefined dropped at ${paths} — Firestore would have refused the whole reply` });
};

const runHandler = async (ref: DocumentReference, claim: Claim, handler: CommandHandler, options: HostRunnerOptions): Promise<HostEvent> => {
  try {
    // Inside the try on purpose: a params value JSON cannot carry throws
    // naming its path, and that lands in the same `handler_error` reply the
    // handler's own failures do, rather than stalling the command.
    const returned = await handler(coerceJsonObject(claim.params));
    const dropped = undefinedPaths(returned);
    reportStripped(unexpectedPaths(dropped, options.expectedUndefined?.[claim.method]), claim, options);
    // The walk above already answered "is there anything to strip", so a clean
    // reply — every reply, normally — is written without copying it first.
    await updateDoc(ref, { status: "done", result: dropped.length === 0 ? returned : stripUndefined(returned), updatedAt: serverTimestamp() });
    return { phase: "done", method: claim.method };
  } catch (error) {
    const message = errorMessage(error);
    await writeError(ref, "handler_error", message);
    return { phase: "error", method: claim.method, message };
  }
};

// A command past its deadline is removed entirely rather than run: give the host
// a chance to clean up out-of-band resources (staged attachments), then delete
// the doc so it is neither reprocessed nor left as a stale error. Both steps are
// best-effort/idempotent, so a snapshot replay surfacing the same expired doc
// twice is harmless (no claim transaction needed — see plan edge #3).
const expireCommand = async (ref: DocumentReference, command: Command, options: HostRunnerOptions, uid: string) => {
  try {
    await options.onExpire?.(command, uid);
  } catch (error) {
    options.onEvent?.({ phase: "error", method: command.method, message: `onExpire failed: ${errorMessage(error)}` });
  }
  // Surface a delete failure (permissions / transient network) the same way the
  // onExpire failure above is surfaced — otherwise the expired doc lingers as
  // "queued" with no signal as to why cleanup didn't happen.
  await deleteDoc(ref).catch((error) => {
    options.onEvent?.({ phase: "error", method: command.method, message: `expire delete failed: ${errorMessage(error)}` });
  });
  options.onEvent?.({ phase: "done", method: command.method, message: "expired" });
};

// Per-runner constants bundled into one context so processCommand stays under the
// max-params cap: firestore, the handler table, options, and the session uid are
// all fixed for the runner's lifetime; only ref/command/now vary per command.
interface RunnerContext {
  firestore: Firestore;
  handlers: CommandHandlers;
  options: HostRunnerOptions;
  uid: string;
}

const processCommand = async (ctx: RunnerContext, ref: DocumentReference, command: Command, now: number) => {
  const { handlers, options } = ctx;
  // Drop an expired command before claiming it — it must never reach a handler.
  if (isExpired(command, now)) {
    await expireCommand(ref, command, options, ctx.uid);
    return;
  }
  const claim = await claimCommand(ctx.firestore, ref);
  if (!claim) {
    return;
  }
  options.onEvent?.({ phase: "received", method: claim.method });
  const handler = resolveCommandHandler(handlers, claim.method);
  if (!handler) {
    await writeError(ref, "unknown_method", `No handler for method: ${claim.method}`);
    options.onEvent?.({ phase: "error", method: claim.method, message: "unknown method" });
    return;
  }
  options.onEvent?.(await runHandler(ref, claim, handler, options));
};

// A resilient command listener: its mutable retry state plus the fixed collaborators.
interface ListenerRun {
  queuedCommands: Query;
  ctx: RunnerContext;
  goOffline: () => void;
  stopped: boolean;
  unsubscribe: () => void;
  retryTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  // Start of the current outage, or null while healthy. `attempt` still drives the
  // backoff ladder; only the give-up decision reads the clock — a MONOTONIC one, so
  // a clock step cannot spend this window on its own.
  downSinceMs: number | null;
}

// Best-effort oldest-first DISPATCH only — commands run concurrently and may
// finish out of order (chat is asynchronous). We sort in memory rather than
// orderBy("createdAt") because a Firestore orderBy silently EXCLUDES docs missing
// the field, dropping every pre-offline-queue command.
const dispatchAddedCommands = (ctx: RunnerContext, snapshot: QuerySnapshot): void => {
  // Wall clock on purpose, unlike the outage timers below: this is compared with a
  // command's `expiresAt`, which the phone stamped from its own clock.
  const now = Date.now();
  snapshot
    .docChanges()
    .filter((change) => change.type === "added")
    // Cast kept (#2692). The runner itself reads only `createdAt`, `expiresAt`
    // and `method` here, but the doc rides verbatim into the host's `onExpire`,
    // whose published signature takes a whole `Command`. Rebuilding one would
    // have to invent the members nothing on this path reads — `status`,
    // `result`, `error`, `createdBy` — and hand a second host's cleanup
    // callback values the document never carried, which is worse than the
    // assertion. Removing it means narrowing `onExpire`'s parameter, a
    // breaking change to a published contract MulmoTerminal also implements.
    .map((change) => ({ ref: change.doc.ref, command: change.doc.data() as Command }))
    .sort((left, right) => byCreatedAt(left.command, right.command))
    .forEach(({ ref, command }) => {
      processCommand(ctx, ref, command, now).catch(noop);
    });
};

// Re-subscribe after a transient error, backing off exponentially.
function scheduleResubscribe(run: ListenerRun): void {
  run.retryTimer = setTimeout(() => subscribeCommands(run), backoffDelayMs(run.attempt));
  run.attempt += 1;
}

// A Firestore onSnapshot error terminates THIS listener and never recovers on its
// own. Transient → re-subscribe with bounded backoff (presence stays online);
// fatal, or failing for longer than the retry window → go offline.
function handleListenError(run: ListenerRun, error: FirestoreError): void {
  run.ctx.options.onEvent?.({ phase: "error", method: "listen", message: error.message });
  if (run.stopped) return;
  const now = monotonicNowMs();
  run.downSinceMs ??= now;
  if (classifyListenerError(error) === "fatal" || shouldGiveUpListening(run.downSinceMs, now)) {
    run.goOffline();
    return;
  }
  scheduleResubscribe(run);
}

function subscribeCommands(run: ListenerRun): void {
  run.retryTimer = null;
  if (run.stopped) return;
  run.unsubscribe = onSnapshot(
    run.queuedCommands,
    (snapshot) => {
      // A healthy snapshot proves the listener recovered: the ladder and the
      // outage clock both start fresh for whatever comes next.
      run.attempt = 0;
      run.downSinceMs = null;
      dispatchAddedCommands(run.ctx, snapshot);
    },
    (error) => handleListenError(run, error),
  );
}

// Subscribe to the queued-command stream; re-subscribe on transient listener
// errors with bounded backoff, go offline on a fatal one. Returns a stop that
// cancels any pending retry and detaches the listener.
const listenForCommands = (queuedCommands: Query, ctx: RunnerContext, goOffline: () => void): (() => void) => {
  const run: ListenerRun = { queuedCommands, ctx, goOffline, stopped: false, unsubscribe: noop, retryTimer: null, attempt: 0, downSinceMs: null };
  subscribeCommands(run);
  return () => {
    run.stopped = true;
    if (run.retryTimer) clearTimeout(run.retryTimer);
    run.unsubscribe();
  };
};

// One running host, as far as shutting it down is concerned. `closed` guards the
// teardown: a presence failure and a fatal listener error can arrive together, and
// each of them ends the runner.
interface HostRun {
  beat: ReturnType<typeof setInterval> | null;
  stopListening: () => void;
  closed: boolean;
}

const heartbeatMs = (options: HostRunnerOptions): number => options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

// How old an acknowledged presence write may be before this runner stops claiming
// to be online. Exported because a host that judges the same freshness from the
// OUTSIDE (a probe reading the doc back) has to apply the runner's threshold, not
// a second copy of it — pass that host's own runner options and the two cannot
// drift when `heartbeatMs` is customised.
export const presenceStaleAfterMs = (options: HostRunnerOptions = {}): number => heartbeatMs(options) * PRESENCE_STALE_BEATS;

// Advertise online/offline + the capability set (method names + protocol version)
// on the same doc the remote already listens to for presence, and watch whether
// those writes are landing — see presenceBeat.ts for why the sensor counts the
// beats that ran rather than the time that passed.
const buildPresenceBeat = (
  firestore: Firestore,
  channel: Channel,
  handlers: CommandHandlers,
  options: HostRunnerOptions,
  onStale: () => void,
): PresenceBeat => {
  const presence = hostDoc(firestore, channel);
  const report = (message: string) => options.onEvent?.({ phase: "error", method: "presence", message });
  return createPresenceBeat({
    write: (online) => setDoc(presence, { ...buildHostPresence(channel, handlers, online, options.machine), updatedAt: serverTimestamp() }),
    onError: (message) => report(`presence write failed: ${message}`),
    onStale: (silentMs) => {
      report(`no presence write acknowledged across ${PRESENCE_STALE_BEATS} beats (${Math.round(silentMs / 1_000)}s) — the remote cannot see this host`);
      onStale();
    },
    staleAfterBeats: PRESENCE_STALE_BEATS,
  });
};

// Stop beating, say goodbye, detach the listener. Announcing offline is
// best-effort — if the channel is the thing that broke, this write goes nowhere,
// which is exactly why the remote judges presence by age rather than by the flag.
const shutDown = (run: HostRun, presence: PresenceBeat): void => {
  if (run.closed) return;
  run.closed = true;
  if (run.beat) clearInterval(run.beat);
  run.beat = null;
  presence.announce(false);
  run.stopListening();
};

// startHostRunner subscribes to queued commands for the given channel and runs
// each one through the supplied handler table. It also announces presence (a
// heartbeat on users/{uid}/hosts/{hostId}) so the remote can tell it is online.
// Returns a stop function that goes offline and detaches the listener.
export const startHostRunner = (firestore: Firestore, channel: Channel, handlers: CommandHandlers, options: HostRunnerOptions = {}): (() => void) => {
  const run: HostRun = { beat: null, stopListening: noop, closed: false };
  const presence = buildPresenceBeat(firestore, channel, handlers, options, goOffline);

  // The channel is gone and re-subscribing is not going to bring it back: hand
  // over to the lifecycle owner, which can re-auth and start a fresh runner.
  function goOffline(): void {
    if (run.closed) return;
    shutDown(run, presence);
    options.onClosed?.();
  }

  presence.announce(true);
  run.beat = setInterval(presence.beat, heartbeatMs(options));

  const queuedCommands = query(commandsCollection(firestore, channel), where("status", "==", "queued"));
  const ctx: RunnerContext = { firestore, handlers, options, uid: channel.uid };
  run.stopListening = listenForCommands(queuedCommands, ctx, goOffline);

  return () => shutDown(run, presence);
};
