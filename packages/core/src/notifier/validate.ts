// Publish-input validation — pure, dependency-free, so every caller
// can share one rule set. Today that is `engine.publish` and
// `updateForPlugin`, both of which throw on error: publish is
// deliberately absent from the HTTP surface (see
// `server/api/routes/notifier.ts`), so the route layer this once also
// served no longer exists.

import type { PublishInput } from "./types.js";

/** Hard caps on publish-input fields. The engine reads each entry on
 *  every list/get call (no in-memory cache), so unbounded fields hurt
 *  every reader. Caps chosen to be generous for legitimate UX copy
 *  while bounding active.json growth: a notification fundamentally is
 *  a short blurb, not a document. */
export const NOTIFIER_LIMITS = {
  titleMax: 200,
  bodyMax: 4000,
  navigateTargetMax: 1000,
  pluginDataMaxBytes: 16 * 1024,
} as const;

function validateTitle(title: string): string | null {
  if (typeof title !== "string" || title.length === 0) return "title must be a non-empty string";
  if (title.length > NOTIFIER_LIMITS.titleMax) return `title exceeds max length of ${NOTIFIER_LIMITS.titleMax} chars`;
  return null;
}

function validateBody(body: string | undefined): string | null {
  if (body === undefined) return null;
  if (body.length > NOTIFIER_LIMITS.bodyMax) return `body exceeds max length of ${NOTIFIER_LIMITS.bodyMax} chars`;
  return null;
}

function validateNavigateTarget(target: string | undefined): string | null {
  if (target === undefined) return null;
  if (target.length === 0) return "navigateTarget must be a non-empty relative path when set";
  if (target.length > NOTIFIER_LIMITS.navigateTargetMax) {
    return `navigateTarget exceeds max length of ${NOTIFIER_LIMITS.navigateTargetMax} chars`;
  }
  // Must be a same-origin relative path. Reject schemes
  // (`javascript:`, `https://...`) and scheme-relative URLs
  // (`//evil.com/...`, which an `<a href>` would resolve to the
  // attacker's origin). One leading "/" only.
  if (!target.startsWith("/") || target.startsWith("//")) {
    return "navigateTarget must be a relative path beginning with a single '/' (no scheme, no '//')";
  }
  return null;
}

function validatePluginData(pluginData: unknown): string | null {
  if (pluginData === undefined) return null;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(pluginData);
  } catch (err) {
    return `pluginData is not JSON-serialisable: ${String(err)}`;
  }
  // `JSON.stringify` returns `undefined` for non-serialisable roots
  // (e.g. a bare function or symbol). Treat that as a serialisation
  // failure so it doesn't slip through as an empty-string size.
  if (typeof serialized !== "string") return "pluginData is not JSON-serialisable";
  if (serialized.length > NOTIFIER_LIMITS.pluginDataMaxBytes) {
    return `pluginData JSON exceeds ${NOTIFIER_LIMITS.pluginDataMaxBytes} bytes`;
  }
  return null;
}

function validateActionCoherence(input: PublishInput): string | null {
  if (input.lifecycle !== "action") return null;
  if (input.severity === "info") {
    return "action lifecycle is incompatible with info severity (use fyi for low-priority pings)";
  }
  if (typeof input.navigateTarget !== "string" || input.navigateTarget.length === 0) {
    return "action lifecycle requires a non-empty navigateTarget";
  }
  return null;
}

/** Validate a `PublishInput`. Returns `null` if OK, or a
 *  human-readable error string. Order matters — shape/size errors are
 *  reported before lifecycle/severity coherence errors so the message
 *  the caller sees points at the most fundamental problem first. */
export function validatePublishInput(input: PublishInput): string | null {
  return (
    validateTitle(input.title) ??
    validateBody(input.body) ??
    validateNavigateTarget(input.navigateTarget) ??
    validatePluginData(input.pluginData) ??
    validateActionCoherence(input)
  );
}
