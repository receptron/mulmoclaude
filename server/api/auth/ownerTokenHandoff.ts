// Which page loads may receive the owner bearer token embedded in index.html
// (#3627). The server binds 127.0.0.1, so a request from anywhere else arrives
// through something the user put in front of it — a tunnel or reverse proxy —
// and that hop also appears as a loopback peer. Only a direct load of
// `http://localhost:<port>` is trusted. Pure: the production handler and the
// dev server's Vite plugin both pass in what they can see.

import type { IncomingHttpHeaders } from "node:http";

// Hostnames a browser on this machine uses to reach the server directly. A
// permitted list: a proxy forwarding its public host is refused, and so is a
// DNS-rebinding page whose hostname merely resolves to 127.0.0.1.
const DIRECT_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

// A proxy that rewrites Host to localhost still says it is there.
const PROXY_HEADERS: readonly string[] = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "tailscale-user-login",
  "via",
];

export type OwnerTokenHandoff = { ok: true } | { ok: false; reason: "remote-peer" | "host" | "forwarded" };

export interface PageRequest {
  remoteAddress: string | undefined;
  headers: IncomingHttpHeaders;
}

/** Node reports an IPv4 peer on a dual-stack socket as `::ffff:127.0.0.1`. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return bare === "::1" || bare.startsWith("127.");
}

const isPortSuffix = (rest: string): boolean => rest === "" || (rest.startsWith(":") && /^\d+$/.test(rest.slice(1)));

/** The Host header's hostname, lowercased and without its port, or null. */
export function hostnameOf(host: string | undefined): string | null {
  if (typeof host !== "string" || host === "") return null;
  const lowered = host.toLowerCase();
  const nameEnd = lowered.startsWith("[") ? lowered.indexOf("]") + 1 : lowered.includes(":") ? lowered.indexOf(":") : lowered.length;
  const name = lowered.slice(0, nameEnd);
  if (name === "" || (lowered.startsWith("[") && nameEnd <= "[]".length)) return null;
  return isPortSuffix(lowered.slice(nameEnd)) ? name : null;
}

export function decideOwnerTokenHandoff(request: PageRequest): OwnerTokenHandoff {
  if (!isLoopbackAddress(request.remoteAddress)) return { ok: false, reason: "remote-peer" };
  const hostname = hostnameOf(request.headers.host);
  if (hostname === null || !DIRECT_HOSTNAMES.includes(hostname)) return { ok: false, reason: "host" };
  if (PROXY_HEADERS.some((name) => request.headers[name] !== undefined)) return { ok: false, reason: "forwarded" };
  return { ok: true };
}
