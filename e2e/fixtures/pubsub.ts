// Shared harness for driving the app's real pub/sub WebSocket from
// Playwright: mock `/api/agent`, accept the Socket.IO handshake, and
// relay a scripted sequence of `data` events on whichever
// `session.<id>` channel the client subscribes to. Used by the
// streaming auto-scroll regression and the stack map-grouping scroll
// regression — both exercise StackView's real watcher/DOM wiring.

import type { Page, Route } from "@playwright/test";
import { E2E_AUTH_TOKEN } from "./authToken";

export function urlEndsWith(suffix: string): (url: URL) => boolean {
  return (url) => url.pathname === suffix;
}

export interface MockSocket {
  send: (data: string) => void;
}

// engine.io OPEN packet. The values are placeholders — the client only reads
// `sid` and the timing fields.
export const ENGINE_IO_OPEN_PACKET = `0${JSON.stringify({ sid: "mock-sid", upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1_000_000 })}`;

// Wire protocol cheat sheet. engine.io packets are one character: 0=open,
// 2=ping, 3=pong, 4=message. socket.io packets ride inside a message, so the
// second character is the socket.io type: 0=connect, 2=event, 4=connect_error.
const ENGINE_IO_PING = "2";
const ENGINE_IO_PONG = "3";
const SOCKET_IO_CONNECT = "40";
const SOCKET_IO_CONNECT_ERROR = "44";

/** What the server sends when the handshake's bearer token is missing or
 *  wrong: a CONNECT_ERROR carrying the same generic message as a 401. */
export const SOCKET_IO_CONNECT_REFUSED_PACKET = `${SOCKET_IO_CONNECT_ERROR}${JSON.stringify({ message: "unauthorized" })}`;

/** The `auth.token` a socket.io CONNECT packet carries: `null` when the packet
 *  has no string token, `undefined` when `text` is not a CONNECT packet. */
export function readConnectPacketToken(text: string): string | null | undefined {
  if (!text.startsWith(SOCKET_IO_CONNECT)) return undefined;
  const payload = text.slice(SOCKET_IO_CONNECT.length);
  if (payload === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const token: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "token") : undefined;
  return typeof token === "string" ? token : null;
}

/** Answer the frames every socket.io client sends before any event: the
 *  engine.io ping, and the CONNECT packet. A CONNECT is acked only when it
 *  carries the token `playwright.config.ts` injects into the page; anything
 *  else gets the server's refusal, so a client that stops sending the token
 *  fails its spec instead of hanging in "connecting" (#3433). Returns true
 *  when `text` was one of those frames. */
export function answerSocketIoControlFrame(text: string, webSocket: MockSocket): boolean {
  if (text === ENGINE_IO_PING) {
    webSocket.send(ENGINE_IO_PONG);
    return true;
  }
  const presentedToken = readConnectPacketToken(text);
  if (presentedToken === undefined) return false;
  webSocket.send(presentedToken === E2E_AUTH_TOKEN ? `${SOCKET_IO_CONNECT}${JSON.stringify({ sid: "mock-socket-sid" })}` : SOCKET_IO_CONNECT_REFUSED_PACKET);
  return true;
}

// Relay a sequence of pub/sub events to the mocked WebSocket with a
// small gap between each send so Vue re-renders between events.
const RENDER_GAP_MS = 20;

// Flag the page sets to let a `startOnRelease` stream go. Read by polling
// rather than pushed, because the stream is driven from Node while the
// signal is raised in the browser.
const RELEASE_FLAG = "__e2eReleaseStream";
const RELEASE_POLL_MS = 25;

interface StreamOptions {
  // Delay before the first event is sent, after the client subscribes.
  // Use when the events must land AFTER an async transcript fetch has
  // populated the session, so they append rather than race the load.
  startDelayMs?: number;
  // Hold the events until the test calls `releaseStream`. Prefer this over
  // `startDelayMs` whenever the test's OWN setup has to finish first: a fixed
  // delay is a race against that setup, and on a loaded machine the setup
  // loses. `stack-sticky-bottom-scroll` failed exactly that way — the events
  // landed before the test could record its "before" metrics, so the growth
  // it then asserted had already happened (#2766).
  startOnRelease?: boolean;
}

/** Let a `startOnRelease` stream start. Call it once the test has captured
 *  whatever state the arriving events are supposed to change. */
export async function releaseStream(page: Page): Promise<void> {
  await page.evaluate((flag) => {
    Reflect.set(globalThis, flag, true);
  }, RELEASE_FLAG);
}

/** Block until `releaseStream` raises the flag, CONSUMING it so each gated
 *  stream needs its own release. Leaving it set would make the gate one-shot
 *  per page: a second `startOnRelease` stream would sail through on the first
 *  stream's signal, which is the silently-not-gating failure this whole file
 *  is about (Codex, #2780).
 *
 *  Deliberately does NOT throw on a missing release. This runs on a promise
 *  `handleSocketFrame` detaches with `void`, so a throw here is an unhandled
 *  rejection, not a test failure — it would be reported after the fact, or
 *  swallowed (CodeRabbit, #2780). Never releasing simply means the events
 *  never send, and the test's own wait for the streamed content fails with a
 *  locator timeout that names what was missing. */
async function waitForRelease(page: Page): Promise<void> {
  const consume = (flag: string): boolean => {
    if (Reflect.get(globalThis, flag) !== true) return false;
    Reflect.deleteProperty(globalThis, flag);
    return true;
  };
  // A closed page ends the wait: the run is over, so there is nothing to send.
  while (!page.isClosed()) {
    if (await page.evaluate(consume, RELEASE_FLAG).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, RELEASE_POLL_MS));
  }
}

async function streamEventsToSocket(page: Page, webSocket: MockSocket, channel: string, events: readonly unknown[], opts: StreamOptions): Promise<void> {
  if (opts.startOnRelease) await waitForRelease(page);
  if (opts.startDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.startDelayMs));
  for (const event of events) {
    webSocket.send(`42${JSON.stringify(["data", { channel, data: event }])}`);
    await new Promise((resolve) => setTimeout(resolve, RENDER_GAP_MS));
  }
  webSocket.send(`42${JSON.stringify(["data", { channel, data: { type: "session_finished" } }])}`);
}

function handleSocketFrame(page: Page, text: string, webSocket: MockSocket, events: readonly unknown[], opts: StreamOptions): void {
  if (answerSocketIoControlFrame(text, webSocket)) return;
  if (!text.startsWith("42")) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(2));
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  const [name, arg] = parsed as [string, unknown];
  if (name !== "subscribe" || typeof arg !== "string" || !arg.startsWith("session.")) return;
  void streamEventsToSocket(page, webSocket, arg, events, opts);
}

// Accept the Socket.IO handshake and relay the scripted events on the
// session channel the client subscribes to.
async function mockPubSubSocket(page: Page, events: readonly unknown[], opts: StreamOptions): Promise<void> {
  await page.routeWebSocket(
    (url) => url.pathname.startsWith("/ws/pubsub"),
    (webSocket) => {
      webSocket.send(ENGINE_IO_OPEN_PACKET);
      webSocket.onMessage((msg) => handleSocketFrame(page, String(msg), webSocket, events, opts));
    },
  );
}

// Stub POST /api/agent so the client believes a run started.
async function mockAgentEndpoint(page: Page): Promise<void> {
  await page.route(urlEndsWith("/api/agent"), (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 202, json: { chatSessionId: "mock-session" } });
  });
}

export async function mockAgentWithPubSub(page: Page, events: readonly unknown[], opts: StreamOptions = {}): Promise<void> {
  await mockPubSubSocket(page, events, opts);
  await mockAgentEndpoint(page);
}

/** Wait until scrollHeight stops growing for two consecutive samples,
 *  meaning streaming has finished and the DOM has settled. Throws on
 *  timeout so a never-settling stream surfaces as a clear failure
 *  rather than silently letting downstream assertions run on a moving
 *  target. */
export async function waitForScrollHeightStable(page: Page, testId: string, opts: { sampleGapMs?: number; maxWaitMs?: number } = {}): Promise<void> {
  const gap = opts.sampleGapMs ?? 300;
  const maxWait = opts.maxWaitMs ?? 10_000;
  const deadline = Date.now() + maxWait;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const current = await page.getByTestId(testId).evaluate((elem) => elem.scrollHeight);
    if (current === last && current > 0) {
      stable++;
      if (stable >= 2) return;
    } else {
      stable = 0;
      last = current;
    }
    await page.waitForTimeout(gap);
  }
  throw new Error(`waitForScrollHeightStable: "${testId}" scrollHeight never stabilised within ${maxWait}ms`);
}

/** Read scrollTop + scrollHeight + clientHeight from a scroll container. */
export async function scrollMetrics(page: Page, testId: string): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return page.getByTestId(testId).evaluate((elem) => ({
    scrollTop: elem.scrollTop,
    scrollHeight: elem.scrollHeight,
    clientHeight: elem.clientHeight,
  }));
}
