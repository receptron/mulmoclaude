// The `/ws/pubsub` handshake carries the bearer token (#3433): the SPA sends
// `auth.token` in the socket.io CONNECT packet, and a refusal from the server
// is shown to the user instead of being retried with the same stale token.
// E2E runs against `yarn dev:client` only, so the socket is a Playwright mock
// speaking the socket.io wire protocol (see `fixtures/pubsub.ts`). This is the
// one spec that checks the token's value; the shared mock acks any CONNECT.

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { E2E_AUTH_TOKEN } from "../fixtures/authToken";
import {
  ENGINE_IO_OPEN_PACKET,
  parseConnectPacket,
  parseEventPacket,
  SOCKET_IO_CONNECT_ACK_PACKET,
  SOCKET_IO_CONNECT_REFUSED_PACKET,
} from "../fixtures/pubsub";

const BANNER = "live-updates-refused-banner";
const RELOAD_BUTTON = "live-updates-refused-reload";

interface SocketLog {
  /** `auth.token` of every CONNECT packet the page sent, in order. */
  tokens: (string | null)[];
  /** `subscribe` events the page sent. The client emits them only after it
   *  has processed the CONNECT ack, so one of these proves the ack landed. */
  subscribes: number;
  /** How many times the page closed the socket. */
  closes: number;
}

// Mock the pubsub socket: answer every CONNECT with `reply` and record what
// the page sends.
async function mockPubSub(page: Page, reply: string): Promise<SocketLog> {
  const socketLog: SocketLog = { tokens: [], subscribes: 0, closes: 0 };
  await page.routeWebSocket(
    (url) => url.pathname.startsWith("/ws/pubsub"),
    (webSocket) => {
      webSocket.send(ENGINE_IO_OPEN_PACKET);
      webSocket.onClose(() => {
        socketLog.closes += 1;
      });
      webSocket.onMessage((msg) => {
        const text = String(msg);
        const connect = parseConnectPacket(text);
        if (connect !== null) {
          socketLog.tokens.push(connect.token);
          webSocket.send(reply);
          return;
        }
        if (parseEventPacket(text)?.name === "subscribe") socketLog.subscribes += 1;
      });
    },
  );
  return socketLog;
}

test.beforeEach(async ({ page }) => {
  await mockAllApis(page);
});

test("the CONNECT packet carries the page's bearer token, and an accepted handshake shows no banner", async ({ page }) => {
  const socketLog = await mockPubSub(page, SOCKET_IO_CONNECT_ACK_PACKET);
  await page.goto("/");
  // The dev-plugin reload listener subscribes at boot, so the socket opens on
  // every page without any user action.
  await expect.poll(() => socketLog.tokens.length).toBeGreaterThan(0);
  expect(socketLog.tokens[0]).toBe(E2E_AUTH_TOKEN);
  // Only once the client has processed the ack has it decided whether to show
  // the banner; asserting its absence earlier would pass on an undecided page.
  await expect.poll(() => socketLog.subscribes).toBeGreaterThan(0);
  await expect(page.getByTestId(BANNER)).toHaveCount(0);
});

test("a refused handshake shows the banner with a reload button, and the page closes the socket instead of retrying", async ({ page }) => {
  const socketLog = await mockPubSub(page, SOCKET_IO_CONNECT_REFUSED_PACKET);
  await page.goto("/");
  await expect(page.getByTestId(BANNER)).toBeVisible();
  await expect(page.getByTestId(RELOAD_BUTTON)).toBeVisible();
  // socket.io destroys the socket on a middleware refusal and, with no other
  // namespace open, closes the connection. A retry with the same stale token
  // would show up as a second CONNECT before that close.
  await expect.poll(() => socketLog.closes).toBe(1);
  expect(socketLog.tokens).toHaveLength(1);
});
