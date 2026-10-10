// E2E regression tests for the chat-send / session-load flow.
// Exercises the code paths touched by the .vue cognitive-complexity
// refactors (PR #177 sendMessage split + #178 session-helpers
// extraction). Each test targets a behaviour that was either
// hand-coded inline in the Vue component before, or a specific
// regression the refactor could silently re-introduce.
//
// Tracks #175.

import { test, expect, type Page, type Route } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";
import { SESSION_A, SESSION_B } from "../fixtures/sessions";
import { ackSocketIoConnect, ENGINE_IO_OPEN_PACKET, parseEventPacket } from "../fixtures/pubsub";

import { ONE_SECOND_MS } from "../../server/utils/time.ts";

function urlEndsWith(suffix: string): (url: URL) => boolean {
  return (url) => url.pathname === suffix;
}

// Mock the `/api/agent` POST to return 202 (fire-and-forget) and
// stream the given events through the pub/sub channel the client
// subscribes to.
//
// PR #311 replaced the raw WebSocket with socket.io, so the mock
// speaks engine.io + socket.io wire protocol rather than plain
// JSON framing. Cheat sheet:
//   engine.io packets (single char): 0=open, 2=ping, 3=pong,
//                                    4=message, 5=upgrade, 6=noop
//   socket.io packets (when wrapped in eio 4=message):
//                                    0=connect, 1=disconnect, 2=event
// So `40` = connect-to-default-namespace, `42["name", arg]` = event
// emit. We only need open/ping/connect/event handling here.
async function mockAgentWithPubSub(page: Page, events: readonly unknown[]): Promise<void> {
  await page.routeWebSocket(
    (url) => url.pathname.startsWith("/ws/pubsub"),
    (webSocket) => {
      // Send the engine.io OPEN packet immediately so the socket.io
      // client can transition from "connecting" to "connected" and
      // start emitting `subscribe` events.
      webSocket.send(ENGINE_IO_OPEN_PACKET);

      webSocket.onMessage((msg) => {
        const text = String(msg);
        // The CONNECT packet. Whether it carries the bearer token is asserted
        // by pubsub-handshake-auth.spec.ts, not here.
        if (ackSocketIoConnect(text, webSocket)) return;
        // Event: `42["subscribe", "session.…"]`.
        const packet = parseEventPacket(text);
        if (packet === null || packet.name !== "subscribe" || typeof packet.arg !== "string" || !packet.arg.startsWith("session.")) {
          return;
        }
        const channel = packet.arg;
        setTimeout(() => {
          for (const event of events) {
            webSocket.send(`42${JSON.stringify(["data", { channel, data: event }])}`);
          }
          webSocket.send(`42${JSON.stringify(["data", { channel, data: { type: "session_finished" } }])}`);
        }, 50);
      });
    },
  );

  // Mock /api/agent to return 202 (fire-and-forget)
  await page.route(urlEndsWith("/api/agent"), (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 202,
      json: { chatSessionId: "mock-session" },
    });
  });
}

// -------- Session selection (load, switch, sidebar merge, tabs) --------

test.describe("session selection", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("loads session A from url", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);

    // The fixture's user message from makeSessionEntries should render.
    await expect(page.locator("text=Hello").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
    await expect(page.locator("text=Hi there!").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("switching sessions updates the canvas", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);
    // Session A entries loaded.
    await expect(page.locator("text=Hi there!").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });

    // Navigate to session B via the URL directly (same entries fixture).
    await page.goto(`/chat/${SESSION_B.id}`);
    await expect(page.locator("text=Hi there!").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });
  });

  test("side panel shows session previews", async ({ page }) => {
    await page.goto("/");

    // Open the session-history side panel.
    await page.getByTestId("session-history-toggle-off").click();

    // Session previews from fixtures should appear.
    await expect(page.locator("text=Hello from session A").first()).toBeVisible();
  });
});

// -------- Send message + pub/sub event parsing --------

test.describe("sending a chat message", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("streams the assistant's text event into the chat list", async ({ page }) => {
    // The happy-path regression: user sends a message, the server
    // returns 202, events arrive via WebSocket pub/sub, and
    // applyAgentEvent pushes them to the session's toolResults.
    await mockAgentWithPubSub(page, [
      { type: "status", message: "Thinking..." },
      { type: "text", message: "Pong from the server" },
    ]);

    await page.goto("/");
    await page.getByTestId("user-input").fill("ping");
    await page.getByTestId("send-btn").click();

    await expect(page.locator("text=Pong from the server").first()).toBeVisible();
    // The user's own message should also be in the list.
    await expect(page.locator("text=ping").first()).toBeVisible();
  });

  test("malformed pub/sub events are handled gracefully", async ({ page }) => {
    // Events that don't match known types are silently ignored by
    // the applyAgentEvent switch. Valid events that follow still render.
    await mockAgentWithPubSub(page, [
      // Unknown type — ignored by the switch.
      { type: "unknown_event" },
      // Valid text event. Must still render.
      { type: "text", message: "survivor message" },
    ]);

    await page.goto("/");
    await page.getByTestId("user-input").fill("hi");
    await page.getByTestId("send-btn").click();

    await expect(page.locator("text=survivor message").first()).toBeVisible();
  });

  test("tool_call events appear in session state", async ({ page }) => {
    // Verify that tool_call events are received and the final text
    // still renders after the tool call sequence.
    await mockAgentWithPubSub(page, [
      { type: "status", message: "Thinking..." },
      {
        type: "tool_call",
        toolUseId: "tu-1",
        toolName: "myTool",
        args: { foo: "bar" },
      },
      {
        type: "tool_call_result",
        toolUseId: "tu-1",
        content: "tool output",
      },
      { type: "text", message: "final message" },
    ]);

    await page.goto("/");
    await page.getByTestId("user-input").fill("chunk test");
    await page.getByTestId("send-btn").click();

    await expect(page.locator("text=final message").first()).toBeVisible();
  });

  test("recovers missed events via re-fetch on session_finished (#350)", async ({ page }) => {
    // Simulate an event gap: the mock sends ONLY session_finished
    // (no text events). The client's toolResults stay empty from the
    // pub/sub stream. But session_finished triggers a re-fetch of
    // /api/sessions/:id which returns the full transcript — the
    // "recovered message" should appear via that path.
    await mockAgentWithPubSub(page, [
      // Deliberately NO text events — simulates pub/sub loss.
    ]);

    // Override /api/sessions/:id to return a transcript with the
    // "recovered" text. Registered AFTER mockAllApis, so it wins
    // for GET requests whose path starts with /api/sessions/ and
    // contains the session id (we capture dynamically below).
    let capturedSessionId: string | null = null;
    await page.route(
      (url) => url.pathname.startsWith("/api/sessions/") && url.pathname !== "/api/sessions",
      (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const sessionId = route.request().url().split("/api/sessions/").pop() ?? "";
        capturedSessionId = sessionId.split("?")[0] ?? null; // strip query
        return route.fulfill({
          json: [
            {
              type: "session_meta",
              roleId: "general",
              sessionId: capturedSessionId,
            },
            { type: "text", source: "user", message: "trigger" },
            {
              type: "text",
              source: "assistant",
              message: "recovered message",
            },
          ],
        });
      },
    );

    await page.goto("/");
    await page.getByTestId("user-input").fill("trigger");
    await page.getByTestId("send-btn").click();

    // "recovered message" was never sent via pub/sub — it should
    // appear only because session_finished triggered a re-fetch.
    await expect(page.locator("text=recovered message").first()).toBeVisible();
  });
});

// -------- Session creation + tab bar --------

test.describe("creating a new session", () => {
  test.beforeEach(async ({ page }) => {
    await mockAllApis(page);
  });

  test("new-session button creates a fresh session", async ({ page }) => {
    await page.goto(`/chat/${SESSION_A.id}`);
    // Ensure the session loaded.
    await expect(page.locator("text=Hi there!").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });

    // Click new session.
    const newSessionBtn = page.getByTestId("new-session-btn");
    await newSessionBtn.click();

    // URL should change to a new session ID (not SESSION_A.id).
    await expect(page).not.toHaveURL(new RegExp(SESSION_A.id));
    // Input should be focused on the new session (see #300).
    await expect(page.getByTestId("user-input")).toBeFocused();
  });

  test("new-session from a session with content preserves it in Back history", async ({ page }) => {
    // createNewSession now only replaces the URL when the current
    // session was empty (nothing worth going back to). When the
    // previous session has real content, the new chat pushes so
    // browser Back returns the user to the transcript they left.
    await page.goto(`/chat/${SESSION_A.id}`);
    await expect(page.locator("text=Hi there!").first()).toBeVisible({
      timeout: 5 * ONE_SECOND_MS,
    });

    await page.getByTestId("new-session-btn").click();
    await expect(page).not.toHaveURL(new RegExp(SESSION_A.id));

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(SESSION_A.id));
    await expect(page.locator("text=Hi there!").first()).toBeVisible();
  });
});
