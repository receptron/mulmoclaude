// Remote-host command-channel protocol — the browser-safe contract shared by a
// host (MulmoClaude, MulmoTerminal) and the remote/mobile client (mulmoserver).
//
// A host signs in to Firebase as the user, listens to that user's per-host
// command queue in Firestore, runs a handler, and writes the result back; the
// remote writes commands and reads results via a real-time listener. This module
// owns the wire types + pure helpers, and must load without the Firebase SDK; the
// Firestore path helpers live in `./server/paths.ts`. It is the single source of
// truth so the host runner and the client never drift on the protocol.
//
// Ported from ../mulmoserver/src/firestore/commandChannel.ts and the per-host
// copy that lived in MulmoClaude's server/remoteHost/. The hostId is
// host-specific ("mulmoclaude", "mulmoterminal") and is supplied by each host.
import { isRecord } from "@mulmoclaude/common";

// JSON payloads carried by the command channel. Explicit JSON types keep the
// channel typed without resorting to any/unknown.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

/** Structural JSON view of `T`, recursively.
 *
 *  TypeScript gives an implicit index signature to type aliases and mapped
 *  types but NOT to interfaces, so a payload assembled from domain interfaces
 *  (`Shortcut`, `FeedSummary`, …) cannot satisfy `Record<string, JsonValue>`
 *  structurally — even though it is plain JSON at runtime. Mapping over `T`
 *  reconstructs it as an anonymous type, which does get that index signature.
 *
 *  Recursive on purpose: a top-level-only map would still leave nested
 *  interfaces (`{ shortcuts: Shortcut[] }`) unassignable, which is the case
 *  every handler here actually has. */
// The function branch must come BEFORE the object branch: a function IS an
// object to TypeScript, so without it a function maps to `{}` and sails
// through — the helper would accept a payload that serialises to nothing.
// Verified: `toJsonObject({ callback: () => undefined })` compiled clean until
// this branch existed (CodeRabbit, #2596).
export type Jsonify<T> = T extends JsonValue
  ? T
  : T extends (...args: never[]) => unknown
    ? never
    : T extends (infer U)[]
      ? Jsonify<U>[]
      : T extends object
        ? { [K in keyof T]: Jsonify<T[K]> }
        : never;

/** Widen a JSON-shaped handler payload to the channel's `JsonObject`.
 *
 *  Exists so the `Jsonify` reasoning above lives in ONE place. Before this,
 *  eight remote-host handlers each carried their own `as unknown as JsonObject`
 *  with the justification re-argued in eight slightly different comments —
 *  which is how a rule stops being reviewable. */
export const toJsonObject = <T extends object>(payload: Jsonify<T>): JsonObject => payload as JsonObject;

const describeNonJson = (value: unknown): string => {
  if (typeof value === "number") return String(value);
  if (typeof value === "object") return "a non-plain object";
  return `a ${typeof value}`;
};

/** Anything carrying its own JSON form — `Date` above all — must be asked for
 *  it rather than walked, because walking a `Date`'s own enumerable keys finds
 *  none and flattens the timestamp to `{}`. This is the step `JSON.stringify`
 *  performs before it recurses, and the channel used to get it for free. */
const hasToJson = (value: object): value is { toJSON: () => unknown } => "toJSON" in value && typeof value.toJSON === "function";

const jsonRepresentationOf = (value: object): unknown => (hasToJson(value) ? value.toJSON() : value);

/** Rebuild `value` as JSON, or throw naming the property that cannot be. */
function toJsonValue(value: unknown, path: string): JsonValue {
  if (Array.isArray(value)) return toJsonItems(value, path);
  if (isRecord(value)) {
    const represented = jsonRepresentationOf(value);
    if (represented !== value) return toJsonValue(represented, path);
    return toJsonEntries(value, path);
  }
  return toJsonScalar(value, path);
}

/** JSON's four scalar forms. Anything else — a function, a class instance, a
 *  non-finite number — is what the channel cannot carry. */
function toJsonScalar(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${path} is ${describeNonJson(value)}, which JSON cannot represent`);
}

function toJsonItems(items: unknown[], path: string): JsonValue[] {
  // An absent element becomes `null`, matching `JSON.stringify` — an array has
  // to keep its length, so a hole cannot simply be dropped the way a key is.
  // `Array.from` rather than `map`, which SKIPS holes and would leave them in
  // the result: `JSON.stringify` renders a hole as null and hides that, but
  // `1 in arr` / `Object.keys` / `forEach` all still see the gap.
  return Array.from(items, (entry, index) => (entry === undefined ? null : toJsonValue(entry, `${path}[${index}]`)));
}

function toJsonEntries(record: Record<string, unknown>, path: string): JsonObject {
  const usable = Object.entries(record).filter(([, value]) => value !== undefined);
  return Object.fromEntries(usable.map(([key, value]) => [key, toJsonValue(value, `${path}.${key}`)]));
}

/** Runtime counterpart to `toJsonObject`, for payloads whose values are typed
 *  `unknown` — a collection record, a projected view row — so no amount of
 *  mapped-type work can PROVE them JSON.
 *
 *  Walks the payload and rebuilds it from the values it actually inspected, so
 *  the returned `JsonObject` is earned rather than asserted. Absent (`undefined`)
 *  properties are dropped exactly as `JSON.stringify` drops them; anything the
 *  channel could not carry — a function, a class instance, `NaN` — throws
 *  naming its path, instead of reaching Firestore as a silently mangled write. */
export const coerceJsonObject = (payload: Record<string, unknown>): JsonObject => toJsonEntries(payload, "payload");

// A channel routes commands to one specific host. A host's first machine uses the
// host's fixed id ("mulmoclaude", "mulmoterminal"); a host that runs on several
// machines gives each later one "<id>-<8 hex>" (RemoteHostDeps.resolveHostId), and
// the remote finds those by listing users/{uid}/hosts.
export interface Channel {
  uid: string;
  hostId: string;
}

export type CommandStatus = "queued" | "processing" | "done" | "error";

export interface CommandError {
  code: string;
  message: string;
}

// One document in a channel's commands subcollection is one API-call-like
// request. The remote (mobile) writes method/params; the host writes
// result/error/status.
export interface Command {
  method: string;
  params: JsonObject;
  status: CommandStatus;
  result: JsonValue;
  error: CommandError | null;
  createdBy: "remote" | "host";
  // Offline-queue fields (all optional; absent ⇒ pre-offline-queue behaviour, so
  // this is backward-compatible with every deployed client). Epoch-millisecond
  // NUMBERS set by the remote at enqueue time — deliberately plain numbers, not
  // Firestore Timestamps, so `isExpired` / `byCreatedAt` stay pure + browser-safe
  // and unit-testable without a Firestore fake. Clock skew over a multi-day expiry
  // window is immaterial. See plans/done/feat-remote-offline-queue.md.
  createdAt?: number; // enqueue time — age/display + best-effort dispatch bias (NOT a strict order guarantee; chat is async)
  expiresAt?: number; // deadline; past it the host deletes the command + its staged attachments
  queuedOffline?: boolean; // emitted while the host was offline (gates the remote's attachment rollback)
}

// A command is expired once `now` reaches its remote-set deadline. Absent
// `expiresAt` ⇒ it never expires (pre-offline-queue commands). Pure with an
// injected `now` for deterministic tests; the runner passes `Date.now()`.
export const isExpired = (command: Pick<Command, "expiresAt">, now: number): boolean => typeof command.expiresAt === "number" && now >= command.expiresAt;

// Best-effort dispatch bias for a drained batch: oldest enqueue first. This is
// NOT an ordering guarantee — commands run concurrently and may complete out of
// order (chat is asynchronous, by design); it only nudges which one starts first.
// A command with no `createdAt` sorts as oldest (0) so it is never starved.
export const byCreatedAt = (left: Pick<Command, "createdAt">, right: Pick<Command, "createdAt">): number => (left.createdAt ?? 0) - (right.createdAt ?? 0);

export type CommandHandler = (params: JsonObject) => JsonValue | Promise<JsonValue>;
export type CommandHandlers = Record<string, CommandHandler>;

/** The param name a collection-serving command uses to say WHICH project's
 *  collections it means. Reserved and documented now, before a phone client
 *  ships, because the parts that are hard to change later are the ones being
 *  written today. Four rules go with it:
 *
 *  1. **It is an OPAQUE scope, never a path.** The phone is a genuinely remote
 *     client; an absolute root in a command, an artifact or a token publishes
 *     the user's home directory over the wire. Mint a project id host-side and
 *     resolve it host-side.
 *  2. **The phone must be able to LEARN the list.** A picker needs
 *     `{ id, label }` pairs from the host — a command of its own, or a field on
 *     an existing listing. Designing the scope value now is what keeps that the
 *     ONLY new thing when the feature lands.
 *  3. **Handlers RESOLVE a scope; they do not hard-code one.** Write each
 *     collection handler as "read the scope from params, defaulting to the
 *     host's root" rather than calling the workspace accessor inline. Today
 *     every call resolves the default and behaves exactly as it does now; the
 *     day the param arrives, no handler changes.
 *  4. **The artifact stays host-built.** A remote view's srcdoc, its inlined
 *     image thumbnails and its token are assembled on the host, so the phone
 *     never resolves a path itself. That is what makes (1) hold without
 *     trusting the client. */
export const COMMAND_SCOPE_PARAM = "project";

/** Read the opaque project scope off a command's params, or `undefined` for
 *  "the host's own root" — which is what every command means today. A
 *  non-string (or empty) value is treated as absent rather than as an error: a
 *  scope the host cannot resolve must fall back to the default, never to a
 *  guess. Hosts pass the result to their own id → root resolver; this module
 *  deliberately never sees a path. */
export const readCommandScope = (params: JsonObject): string | undefined => {
  const raw = params[COMMAND_SCOPE_PARAM];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
};

// Bumped when the command-channel wire protocol changes in a way the remote must
// gate on. Advertised in the presence doc so the remote can check compatibility
// before issuing commands.
//
// v2: offline queueing. The host honours `expiresAt` (deletes an expired command
// + its staged attachments instead of spawning a stale chat). A remote MUST see
// protocolVersion >= 2 before queueing a startChat while the host is offline —
// a v1 host silently ignores `expiresAt`, so a queued chat would spawn stale on
// reconnect with its uploads never cleaned up.
export const REMOTE_HOST_PROTOCOL_VERSION = 2;

// The presence doc's payload: online flag + a capability advertisement. Written
// by the host on every heartbeat; the remote reads it from the presence listener
// it already runs (no extra round trip, known the instant the host is online).
// Browser-safe so the mobile client compiles against the same shape.
// `updatedAt` (a Firestore serverTimestamp) is added by the runner at write time
// and is intentionally not part of this capability contract.
// Which machine a presence comes from, for a host that can run on several machines
// under one account (mulmoterminal#3092): a stable id the host recognises itself by,
// and the name the remote shows for it.
export interface HostMachine {
  machineId: string;
  label: string;
}

export interface HostPresence {
  online: boolean;
  hostId: string;
  protocolVersion: number;
  // Method names the host serves — the keys of the live handler table.
  capabilities: string[];
  machineId?: string;
  label?: string;
}

// Build the presence payload from the live handler table. Capabilities are
// `Object.keys(handlers)` so registering a handler is the ONLY step needed to
// advertise it — there is no second list to keep in sync.
export const buildHostPresence = (channel: Channel, handlers: CommandHandlers, online: boolean, machine?: HostMachine): HostPresence => ({
  online,
  hostId: channel.hostId,
  protocolVersion: REMOTE_HOST_PROTOCOL_VERSION,
  capabilities: Object.keys(handlers),
  ...(machine ? { machineId: machine.machineId, label: machine.label } : {}),
});

// Channel health as the resilient runner reports it. Browser-safe alongside the
// wire types because the control that renders it runs in the client.
export { RUNNER_HEALTH_STATES, isRunnerHealth, isRunnerHealthState } from "./health.js";
export type { RunnerHealth, RunnerHealthState } from "./health.js";
