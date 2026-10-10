// Shared harness for driving the app's real pub/sub WebSocket from
// Playwright: mock `/api/agent`, accept the Socket.IO handshake, and
// relay a scripted sequence of `data` events on whichever
// `session.<id>` channel the client subscribes to. Used by the
// streaming auto-scroll regression and the stack map-grouping scroll
// regression — both exercise StackView's real watcher/DOM wiring.

import type { Page, Route } from "@playwright/test";
import { hasStringProp, isUnknownArray } from "../../src/utils/types";

export function urlEndsWith(suffix: string): (url: URL) => boolean {
  return (url) => url.pathname === suffix;
}

export interface MockSocket {
  send: (data: string) => void;
}

// engine.io OPEN packet. The values are placeholders — the client only reads
// `sid` and the timing fields. The mock never sends the server-side ping
// engine.io v4 expects, so a page is closed for a missed heartbeat only after
// pingInterval + pingTimeout, longer than any spec runs.
export const ENGINE_IO_OPEN_PACKET = `0${JSON.stringify({ sid: "mock-sid", upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1_000_000 })}`;

// Wire protocol cheat sheet. engine.io packets are one character: 0=open,
// 2=ping (server to client), 3=pong (the client's reply), 4=message. socket.io
// packets ride inside a message, so the second character is the socket.io
// type: 0=connect, 2=event, 4=connect_error.
const SOCKET_IO_CONNECT = "40";
const SOCKET_IO_EVENT = "42";
const SOCKET_IO_CONNECT_ERROR = "44";

/** What the server sends back for an accepted CONNECT. */
export const SOCKET_IO_CONNECT_ACK_PACKET = `${SOCKET_IO_CONNECT}${JSON.stringify({ sid: "mock-socket-sid" })}`;

/** What the server sends when the handshake's bearer token is missing or
 *  wrong: a CONNECT_ERROR carrying the same generic message as a 401. */
export const SOCKET_IO_CONNECT_REFUSED_PACKET = `${SOCKET_IO_CONNECT_ERROR}${JSON.stringify({ message: "unauthorized" })}`;

/** The payload of a socket.io CONNECT packet (`40{…}`), `null` when `text` is
 *  some other frame. `token` is `null` when the packet carries no string one. */
export function parseConnectPacket(text: string): { token: string | null } | null {
  if (!text.startsWith(SOCKET_IO_CONNECT)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(text.slice(SOCKET_IO_CONNECT.length));
  } catch {
    return { token: null };
  }
  return { token: hasStringProp(payload, "token") ? payload.token : null };
}

/** A socket.io EVENT packet (`42["name", arg]`), `null` for any other frame. */
export function parseEventPacket(text: string): { name: string; arg: unknown } | null {
  if (!text.startsWith(SOCKET_IO_EVENT)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(text.slice(SOCKET_IO_EVENT.length));
  } catch {
    return null;
  }
  if (!isUnknownArray(payload)) return null;
  const [name, arg] = payload;
  if (typeof name !== "string") return null;
  return { name, arg };
}

/** Ack a socket.io CONNECT packet the way the server does. Any well-formed
 *  CONNECT is accepted here: whether the page presents the bearer token is
 *  asserted by `pubsub-handshake-auth.spec.ts` alone, so a stale Vite left on
 *  the e2e port (its token differs) fails that one spec with a message instead
 *  of every streaming spec with a locator timeout. Returns true when `text`
 *  was a CONNECT. */
export function ackSocketIoConnect(text: string, webSocket: MockSocket): boolean {
  if (parseConnectPacket(text) === null) return false;
  webSocket.send(SOCKET_IO_CONNECT_ACK_PACKET);
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
  if (ackSocketIoConnect(text, webSocket)) return;
  const event = parseEventPacket(text);
  if (event === null || event.name !== "subscribe" || typeof event.arg !== "string" || !event.arg.startsWith("session.")) return;
  void streamEventsToSocket(page, webSocket, event.arg, events, opts);
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
