// The `/ws/pubsub` handshake carries the bearer token (#3433): the SPA sends
// `auth.token` in the socket.io CONNECT packet, and a refusal from the server
// is shown to the user instead of being retried with the same stale token.
// E2E runs against `yarn dev:client` only, so the socket is a Playwright mock
// speaking the socket.io wire protocol (see `fixtures/pubsub.ts`).

import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { E2E_AUTH_TOKEN } from "../fixtures/authToken";
import { answerSocketIoControlFrame, ENGINE_IO_OPEN_PACKET, readConnectPacketToken, SOCKET_IO_CONNECT_REFUSED_PACKET } from "../fixtures/pubsub";

const BANNER = "live-updates-refused-banner";
const RELOAD_BUTTON = "live-updates-refused-reload";

interface SocketLog {
  /** `auth.token` of every CONNECT packet the page sent, in order. */
  tokens: (string | null)[];
  /** How many times the page closed the socket. */
  closes: number;
}

// Mock the pubsub socket, recording every CONNECT packet's token and every
// close from the page. In `check-token` mode the fixture acks a CONNECT that
// carries the injected token; in `refuse` mode every CONNECT gets the
// server's refusal.
async function mockPubSub(page: Page, mode: "check-token" | "refuse"): Promise<SocketLog> {
  const socketLog: SocketLog = { tokens: [], closes: 0 };
  await page.routeWebSocket(
    (url) => url.pathname.startsWith("/ws/pubsub"),
    (webSocket) => {
      webSocket.send(ENGINE_IO_OPEN_PACKET);
      webSocket.onClose(() => {
        socketLog.closes += 1;
      });
      webSocket.onMessage((msg) => {
        const text = String(msg);
        const presentedToken = readConnectPacketToken(text);
        if (presentedToken !== undefined) socketLog.tokens.push(presentedToken);
        if (presentedToken !== undefined && mode === "refuse") {
          webSocket.send(SOCKET_IO_CONNECT_REFUSED_PACKET);
          return;
        }
        answerSocketIoControlFrame(text, webSocket);
      });
    },
  );
  return socketLog;
}

test.beforeEach(async ({ page }) => {
  await mockAllApis(page);
});

test("the CONNECT packet carries the page's bearer token", async ({ page }) => {
  const socketLog = await mockPubSub(page, "check-token");
  await page.goto("/");
  // The dev-plugin reload listener subscribes at boot, so the socket opens on
  // every page without any user action.
  await expect.poll(() => socketLog.tokens.length).toBeGreaterThan(0);
  expect(socketLog.tokens[0]).toBe(E2E_AUTH_TOKEN);
  await expect(page.getByTestId("app-title")).toBeVisible();
  await expect(page.getByTestId(BANNER)).toHaveCount(0);
});

test("a refused handshake shows the banner with a reload button, and the page closes the socket instead of retrying", async ({ page }) => {
  const socketLog = await mockPubSub(page, "refuse");
  await page.goto("/");
  await expect(page.getByTestId(BANNER)).toBeVisible();
  await expect(page.getByTestId(RELOAD_BUTTON)).toBeVisible();
  // socket.io destroys the socket on a middleware refusal and, with no other
  // namespace open, closes the connection. A retry with the same stale token
  // would show up as a second CONNECT before that close.
  await expect.poll(() => socketLog.closes).toBe(1);
  expect(socketLog.tokens).toHaveLength(1);
});
