// Env-var scraper for the relay path's bridge options bag (#739).
//
// Same scheme as `readBridgeEnvOptions` in `@mulmobridge/client`
// (PR #729), but for the relay world: one MulmoClaude server process
// consumes many platforms (LINE / WhatsApp / Messenger / Google Chat
// / Teams / …) so the prefix is `RELAY_<PLATFORM>_*` instead of
// `<TRANSPORT>_BRIDGE_*`. The scan algorithm itself is the shared
// `scanEnvOptions` in `@mulmoclaude/common` (#2487); this wrapper
// only contributes the relay prefixes and the allowlist below.
//
// Env scheme:
//
//   RELAY_<KEY>             — blanket fallback for every platform
//   RELAY_<PLATFORM>_<KEY>  — per-platform override (wins on clash)
//
// Both forms strip the prefix and convert the `UPPER_SNAKE` tail to
// `lowerCamel`. Empty-string values are dropped so a stray
// `FOO=""` doesn't shadow `BAR`'s match. Platform names with dashes
// (`google-chat`) are normalised to underscores in the env prefix:
// `google-chat` → `RELAY_GOOGLE_CHAT_*`. Dashes break shells; `_`
// is the portable convention.
//
// **Allowlist guard**: bridges keep secrets out of the scrape via
// the `_BRIDGE_` marker (`SLACK_BOT_TOKEN` has no `_BRIDGE_`, so
// it's never scraped). The relay scheme has no such marker — every
// `RELAY_*` would otherwise be a candidate, and we have real
// infrastructure secrets in that namespace (`RELAY_TOKEN`,
// `RELAY_URL`). To prevent leakage into `bridgeOptions` (which is
// forwarded to the agent and may be logged), the scan runs with
// `allowKeys: RECOGNISED_KEYS` — only listed keys are emitted.
// Adding a new option (e.g. a future `RELAY_LINE_SOURCEWATCH`) is a
// deliberate one-line edit here — friction is the point.
//
// Resolution at startup:
//
//   RELAY_DEFAULT_ROLE=general
//   RELAY_LINE_DEFAULT_ROLE=line-support
//
//   resolveRelayBridgeOptions("line", env)       → { defaultRole: "line-support" }
//   resolveRelayBridgeOptions("whatsapp", env)   → { defaultRole: "general" }
//   resolveRelayBridgeOptions("google-chat", env) // reads RELAY_GOOGLE_CHAT_*

import { scanEnvOptions } from "@mulmoclaude/common";

const BLANKET_PREFIX = "RELAY_";

// Closed set of bridge-option keys the relay path may forward.
// Stored in lowerCamel form (the bag's wire shape). Adding a new
// recognized option means appending one entry here.
const RECOGNISED_KEYS: ReadonlySet<string> = new Set(["defaultRole", "replyTimeoutMs"]);

// Build the per-platform prefix for a given platform name. Same
// normalisation as bridges' `<TRANSPORT>_BRIDGE_` — uppercase plus
// dashes-to-underscores. A blank platform yields `null` (caller
// then only resolves the blanket form).
function platformPrefix(platform: string): string | null {
  const normalised = platform.toUpperCase().replace(/-/g, "_");
  if (normalised.length === 0) return null;
  return `RELAY_${normalised}_`;
}

/**
 * Read `RELAY_*` and `RELAY_<PLATFORM>_*` env vars into a
 * lowerCamel-keyed bag suitable for `relay({ ..., bridgeOptions })`.
 *
 * Per-platform overrides shared on conflict. Empty-string values are
 * skipped. Keys not in `RECOGNISED_KEYS` are dropped — protects
 * `RELAY_TOKEN` / `RELAY_URL` (infrastructure secrets) from leaking
 * into chat sessions. Returns an empty object when no relevant vars
 * are set — always safe to forward to `relay()`.
 */
export function resolveRelayBridgeOptions(platform: string, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const perPlatformPrefix = platformPrefix(platform);
  const prefixes = perPlatformPrefix === null ? [BLANKET_PREFIX] : [BLANKET_PREFIX, perPlatformPrefix];
  return scanEnvOptions(env, { prefixes, allowKeys: RECOGNISED_KEYS });
}
