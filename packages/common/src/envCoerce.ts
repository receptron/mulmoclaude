// Env-var type coercion for ports and other integer settings.
//
// It started inside `server/system/env.ts` (#504-era), moved to
// `server/utils/envCoerce.ts` when #2650 needed the SAME rule for `yarn dev`'s
// Vite proxy — the proxy has to resolve `PORT` exactly as the backend does, or
// the two point at different servers — and moved here when #3084 needed it for
// the messaging bridges too. A second opinion about "is this a port" is that
// bug one level down, so there is exactly one copy and every tier imports it.

export interface IntRange {
  min?: number;
  max?: number;
}

/**
 * `Number()`-based integer coercion with an optional range, falling back when the
 * value is absent, empty, non-integer, or out of range.
 *
 * `Number()` — not `parseInt` — on purpose: it is what the server has always used,
 * so `0x1f`, `1e3`, `+3100` and `3100.0` coerce exactly as they did, and a
 * whitespace-only value coerces to 0. Anything stricter here would silently
 * disagree with the backend.
 */
export function asInt(value: string | undefined, fallback: number, opts: IntRange = {}): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  if (opts.min !== undefined && parsed < opts.min) return fallback;
  if (opts.max !== undefined && parsed > opts.max) return fallback;
  return parsed;
}

/** The port range the backend accepts, so both sides bound the value identically.
 *  `min: 0` is deliberate — 0 asks the OS for an ephemeral port.
 *
 *  `Required<IntRange>`, not `IntRange`: both bounds are always present here, and
 *  saying so lets a caller compare against them (`port <= PORT_RANGE.max`) without
 *  a non-null assertion. Still assignable wherever an `IntRange` is expected. */
export const PORT_RANGE: Required<IntRange> = Object.freeze({ min: 0, max: 65_535 });
