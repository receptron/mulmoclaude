// @mulmobridge/webhook-runtime — shared HTTP-webhook plumbing for the
// messaging bridges that receive events over an inbound webhook (LINE,
// WhatsApp, Viber, LINE WORKS, Google Chat, Messenger).
//
// Each of those bridges used to inline the same Express setup, the same
// `BRIDGE_TRUST_PROXY` parsing, the same rate-limit config and the same
// timing-safe HMAC check. Those are security-relevant and were hardened
// through several Codex reviews (#1326); keeping six copies means a fix
// has to be applied six times. This package is the single source.

import crypto from "crypto";
import type { Server } from "node:http";
import express, { type Express, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";
import { hasNumberProp } from "@mulmoclaude/common";
import { describeListenError, resolveWebhookPort } from "./port.js";

// Honour an explicit `trust proxy` setting so `req.ip` (the rate-limit
// key) reflects the real client IP rather than the load balancer's.
// Default `false` for safety; operators behind a known LB choose from:
//   - hop count:  BRIDGE_TRUST_PROXY=1
//   - boolean:    BRIDGE_TRUST_PROXY=true / false
//   - preset:     BRIDGE_TRUST_PROXY=loopback
//   - CIDR list:  BRIDGE_TRUST_PROXY=10.0.0.0/8,192.168.0.0/16
// Without this every webhook looks like it comes from one IP and the
// limiter degrades into a global throttle. The boolean branch is
// required because Express does NOT auto-convert string "true"/"false"
// — without it, `BRIDGE_TRUST_PROXY=true` is read as a (never-matching)
// CIDR rule (Codex reviews on #1326).
function parseTrustProxyValue(env: string): boolean | number | string {
  const lower = env.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  const numeric = Number(env);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : env;
}

export function configureTrustProxy(app: Express, env: string | undefined = process.env.BRIDGE_TRUST_PROXY): void {
  if (!env) return;
  app.set("trust proxy", parseTrustProxyValue(env));
}

// The base Express app shared by every webhook bridge: hide the
// `x-powered-by` banner, honour `BRIDGE_TRUST_PROXY`, and parse the body
// as raw text so the HMAC signature can be verified before JSON parsing.
// `bodyLimit` overrides the body-size cap (default: Express's 100kb) for
// platforms that send larger payloads.
export function createWebhookApp(opts: { bodyLimit?: string } = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  configureTrustProxy(app);
  app.use(express.text({ type: "application/json", limit: opts.bodyLimit }));
  return app;
}

// Per-IP throttle for a webhook endpoint. CodeQL's
// `js/missing-rate-limiting` rule recognises `express-rate-limit`
// specifically; the default 120 req/min/IP cap sits well above any
// messaging platform's normal delivery rate and exists to bound a flood
// / stuck retry loop.
export function createWebhookRateLimit(limitPerMinute = 120): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMinute,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Route through `ipKeyGenerator(...)` so IPv6 clients get folded to
    // their /56 subnet — a raw `req.ip` key would let IPv6 rotation
    // within a prefix evade the per-client limit. `req.ip` is
    // trust-proxy-aware via `configureTrustProxy`. (Codex reviews on #1326.)
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? "", 56),
  });
}

// Timing-safe HMAC signature check. `algorithm` is the OpenSSL digest
// name (e.g. "SHA256"); `encoding` is how the platform encodes the
// signature it sends (LINE / LINE WORKS: base64; Meta: hex).
//
// The length guard compares BYTE lengths, not string lengths: a
// malformed non-ASCII signature can share `expected`'s JS string length
// while `Buffer.from()` yields more bytes, and `timingSafeEqual` throws
// on unequal-length buffers. Comparing the buffers keeps a bad signature
// a deterministic `false` (fail closed) instead of a thrown 500 — this
// is what the per-bridge `try/catch` wrappers used to guarantee.
export function verifyHmacSignature(
  body: string,
  signature: string,
  secret: string,
  algorithm = "SHA256",
  encoding: crypto.BinaryToTextEncoding = "base64",
): boolean {
  const expected = Buffer.from(crypto.createHmac(algorithm, secret).update(body).digest(encoding));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

// ── Meta (Messenger / WhatsApp) webhook verification ───────────
//
// Meta's GET handshake echoes back `hub.challenge`. Narrowing it to a
// known shape before it reaches `res.send()` is the CodeQL sanitiser that
// clears the `js/reflected-xss` alert (Codex review on #1328) and gives
// defence-in-depth. `[A-Za-z0-9_-]{1,256}` covers every observed base64url
// nonce (~32 chars); widen it HERE if Meta ever extends the format.
export const SAFE_CHALLENGE_RE = /^[A-Za-z0-9_-]{1,256}$/;

/** The challenge string when `raw` matches the shape we'll echo, else
 *  `null`. Non-string query forms (`?hub.challenge[]=…`) return `null`
 *  rather than coercing to "", so callers can't compare a coerced empty. */
export function narrowChallenge(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (!SAFE_CHALLENGE_RE.test(raw)) return null;
  return raw;
}

export interface MetaVerificationResult {
  status: 200 | 403;
  body: string;
  verified: boolean;
}

// Pure decision for Meta's GET handshake: echo `hub.challenge` only when
// `hub.mode=subscribe`, `hub.verify_token` matches, and the challenge clears
// `narrowChallenge`. Split out from the Express handler so it can be tested
// without a request object. Messenger and WhatsApp share this byte-for-byte.
export function metaVerificationResult(query: Record<string, unknown>, verifyToken: string): MetaVerificationResult {
  const challenge = narrowChallenge(query["hub.challenge"]);
  if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === verifyToken && challenge !== null) {
    return { status: 200, body: challenge, verified: true };
  }
  return { status: 403, body: "Forbidden", verified: false };
}

export interface MetaWebhookVerificationOptions {
  rateLimit: RateLimitRequestHandler;
  verifyToken: string;
  /** Log prefix, e.g. "messenger" / "whatsapp". */
  label: string;
}

// Register the shared Meta webhook-verification GET handler (Messenger,
// WhatsApp). Always `text/plain` — the CodeQL `js/reflected-xss` defence for
// the echoed challenge (see narrowChallenge + SAFE_CHALLENGE_RE above).
export function registerMetaWebhookVerification(app: Express, opts: MetaWebhookVerificationOptions): void {
  app.get("/webhook", opts.rateLimit, (req: Request, res: Response) => {
    const result = metaVerificationResult(req.query, opts.verifyToken);
    if (result.verified) console.log(`[${opts.label}] webhook verified`);
    res.status(result.status).type("text/plain").send(result.body);
  });
}

// Meta prefixes the x-hub-signature-256 hex digest with `sha256=`; strip it
// before the timing-safe compare. Wraps the generic hex/SHA-256 HMAC check so
// the Messenger and WhatsApp bridges stop carrying identical copies.
export function verifyMetaHmacSignature(rawBody: string, signature: string, appSecret: string): boolean {
  return verifyHmacSignature(rawBody, signature.replace("sha256=", ""), appSecret, "sha256", "hex");
}

export interface MetaWebhookOptions {
  verifyToken: string;
  appSecret: string;
  /** Log prefix, e.g. "messenger" / "whatsapp". */
  label: string;
  /** Body of the 200 ack. Meta ignores it, but each bridge shipped its own
   *  string, so it stays configurable rather than silently changing. */
  ackBody?: string;
  /** Runs after the ack, on a signature-verified body. Must not throw — a
   *  rejection here lands in an already-answered request. */
  onBody: (rawBody: string) => Promise<void>;
}

// Register both halves of a Meta webhook (Messenger, WhatsApp): the GET
// verification handshake and the POST event delivery. The POST body arrives as
// raw text (see createWebhookApp) so the HMAC covers exactly the bytes Meta
// signed.
//
// One limiter covers both routes — a flood of bogus `hub.challenge` GET probes
// hammers the bridge just as effectively as POST traffic, so they share a
// bucket rather than getting one cap each. It is built HERE rather than taken
// as an argument because `js/missing-rate-limiting` only recognises the
// `express-rate-limit` call when it is visible at route setup; behind a
// parameter CodeQL cannot tell the signature check is throttled.
export function registerMetaWebhook(app: Express, opts: MetaWebhookOptions): void {
  const webhookRateLimit = createWebhookRateLimit();
  registerMetaWebhookVerification(app, { rateLimit: webhookRateLimit, verifyToken: opts.verifyToken, label: opts.label });

  app.post("/webhook", webhookRateLimit, async (req: Request, res: Response) => {
    const signature = typeof req.headers["x-hub-signature-256"] === "string" ? req.headers["x-hub-signature-256"] : "";
    const rawBody = typeof req.body === "string" ? req.body : "";

    if (!signature || !verifyMetaHmacSignature(rawBody, signature, opts.appSecret)) {
      console.warn(`[${opts.label}] AUTH_FAILED: signature verification failed`);
      res.status(401).send("Invalid signature");
      return;
    }

    // Ack before processing: Meta re-delivers anything it doesn't see
    // acknowledged within seconds, so the reply must not wait on the agent.
    res.status(200).send(opts.ackBody ?? "EVENT_RECEIVED");
    await opts.onBody(rawBody);
  });
}

export interface ListenWebhookOptions {
  /** The env var that overrides the port. Every message names it — each bridge
   *  has a different one, and "which knob do I turn" is the question an
   *  operator has at exactly the moment this fails. */
  envVar: string;
  /** Port used when the env var is unset or blank. */
  fallback: number;
  /** Test seam. Production prints the message and exits non-zero. */
  onFatal?: (message: string) => void;
}

// Bind a bridge's webhook port, and say something useful when that fails.
//
// Before #3084 each bridge did `Number(process.env.X) || N` and a bare
// `app.listen(PORT, cb)`: a typo ran on the default without a word, `X=0` was
// impossible, and `EADDRINUSE` surfaced as an unhandled error with no mention
// of which env var to change. The server's port band (3002-3021) overlaps the
// bridge band (3002-3013), so that collision is routine, not theoretical
// (#3079).
export function listenWebhook(app: Express, opts: ListenWebhookOptions, onReady: (port: number) => void): Server | undefined {
  const fatal = opts.onFatal ?? exitWithMessage;
  const resolved = resolveWebhookPort(process.env[opts.envVar], opts.fallback, opts.envVar);
  if (!resolved.ok) {
    fatal(resolved.message);
    return undefined;
  }
  const server = app.listen(resolved.port, () => {
    // `server.address()` is the authority on whether the bind happened, and on
    // which port it got (it differs from the requested one for `=0`). Express 5
    // runs this callback even when the bind FAILED — verified against
    // express@5.1: `address()` is null, `listening` is false, and the 'error'
    // event arrives on the next tick. Without this guard a bridge prints its
    // "listening on <port>" banner for a server that never bound, which is the
    // same silence #3084 is about, one step later.
    const address = server.address();
    if (!hasNumberProp(address, "port")) return;
    onReady(address.port);
  });
  server.on("error", (err: unknown) => fatal(describeListenError(err, resolved.port, opts.envVar)));
  return server;
}

function exitWithMessage(message: string): void {
  console.error(message);
  process.exit(1);
}
