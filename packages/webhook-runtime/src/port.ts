// Port resolution and bind diagnostics for the webhook bridges (#3084).
//
// Pure on purpose — no `process`, no sockets — so both decisions can be tested
// directly: WHICH port a bridge binds, and WHAT a human is told when the bind
// fails. `listenWebhook` in `index.ts` is the only part that touches the world.

import { asInt, errorMessage, isErrorWithCode, PORT_RANGE } from "@mulmoclaude/common";

// A fallback that `asInt` can never produce from a real value, since
// `PORT_RANGE.min` is 0. Comparing against it turns `asInt`'s "fell back"
// into "the operator typed something unusable", without changing `asInt`'s
// contract (it returns the fallback for bad input by design).
const UNUSABLE = -1;

export type PortResolution = { readonly ok: true; readonly port: number } | { readonly ok: false; readonly message: string };

/** Resolve a bridge's listen port from its env var, or say why it cannot be used.
 *  `raw` is passed in rather than read here so this stays pure. */
export function resolveWebhookPort(raw: string | undefined, fallback: number, envVar: string): PortResolution {
  // A blank value means "not configured", which is what `Number(x) || N` did
  // for the nine bridges before this — `asInt` alone would read it as 0 and
  // ask the OS for an ephemeral port.
  if (raw === undefined || raw.trim() === "") return { ok: true, port: fallback };
  const port = asInt(raw, UNUSABLE, PORT_RANGE);
  if (port === UNUSABLE) {
    return {
      ok: false,
      message: `${envVar}="${raw}" is not a usable port. Set it to an integer from ${PORT_RANGE.min} to ${PORT_RANGE.max} (${envVar}=0 asks the OS for a free port), or unset it to use ${fallback}.`,
    };
  }
  return { ok: true, port };
}

/** What to tell the operator when `listen` fails. Names the env var, because
 *  every bridge uses a different one and "which knob do I turn" is the whole
 *  question at that moment. */
export function describeListenError(err: unknown, port: number, envVar: string): string {
  if (isErrorWithCode(err) && err.code === "EADDRINUSE") {
    return `Port ${port} is already in use. Set ${envVar} to a free port, or ${envVar}=0 to let the OS pick one.`;
  }
  if (isErrorWithCode(err) && err.code === "EACCES") {
    return `Port ${port} needs elevated privileges. Set ${envVar} to a port above 1023.`;
  }
  return `Failed to listen on port ${port} (set ${envVar} to change it): ${errorMessage(err)}`;
}
