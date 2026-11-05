// Which `/api/*` paths a client token may NOT call (#3618): settings, secrets,
// and everything that changes how the host itself behaves or runs the agent
// outside a bridge chat. A leaked client token should reach the data external
// services read and write, not the keys to the house. Pure.
//
// Bridge chats (`/api/transports/…`, `/ws/chat`) stay open: a bridge is the
// main reason to issue a client token at all.

// Relative to the `/api` mount, which is where `bearerAuth` sees them.
const OWNER_ONLY_PREFIXES: readonly string[] = [
  "/agent",
  "/internal",
  "/config",
  "/secrets",
  "/roles",
  "/skills",
  "/scheduler",
  "/plugins",
  "/hooks",
  "/mcp",
  "/mcp-tools",
  "/shutdown",
  "/remote-host",
  "/google",
  "/diagnostics",
  "/sandbox",
  "/shortcuts",
  "/collections-registry",
];

// Express matches routes case-insensitively and does not collapse `//`, so the
// check folds both and strips a trailing slash; an undecodable path is treated
// as owner-only rather than guessed at.
function normalizeApiPath(rawPath: string): string | null {
  try {
    const decoded = decodeURIComponent(rawPath).toLowerCase();
    const collapsed = decoded.replace(/\/{2,}/g, "/");
    return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
  } catch {
    return null;
  }
}

export function isOwnerOnlyApiPath(rawPath: string): boolean {
  const normalized = normalizeApiPath(rawPath);
  if (normalized === null) return true;
  return OWNER_ONLY_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
