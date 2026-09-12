// `publishNotification` is injected (#803) so tests can mock the macOS /
// bell side effects.

import { publishNotification } from "../../events/notifications.js";
import { NOTIFICATION_ACTION_TYPES, NOTIFICATION_KINDS, NOTIFICATION_VIEWS } from "../../../src/types/notification.js";
import type { McpToolContext } from "./index.js";

export type NotifyPublishFn = typeof publishNotification;

export interface NotifyToolDeps {
  publish: NotifyPublishFn;
}

// When the bridge threads a chat session through, mark the
// notification's primary action as "open the originating chat" so
// the user can click the bell entry and land back on the session
// that produced it (typically a scheduled / background chat that
// finished while they were elsewhere). Without a session id, fall
// back to plain push — entry is just dismissed on click, which is
// the unchanged pre-fix behaviour.
function buildNavigateAction(ctx?: McpToolContext) {
  if (!ctx?.sessionId || ctx.sessionId.length === 0) return undefined;
  return {
    type: NOTIFICATION_ACTION_TYPES.navigate,
    target: { view: NOTIFICATION_VIEWS.chat, sessionId: ctx.sessionId },
  };
}

export function makeNotifyTool(deps: NotifyToolDeps) {
  return {
    definition: {
      name: "notify",
      description:
        "Send the user a push-style notification (the web bell, plus macOS Reminders on darwin unless DISABLE_MACOS_REMINDER_NOTIFICATIONS=1). Use to report completion of long-running tasks, surface monitoring results, or proactively notify the user when they may be away from the keyboard.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short notification headline. Keep it concise — emojis OK.",
          },
          body: {
            type: "string",
            description: "Optional longer detail line. Omit when the title is self-explanatory.",
          },
        },
        required: ["title"],
      },
    },

    prompt:
      "Use the `notify` MCP tool — NOT a user-installed `/notify` skill — when the user asks for a notification ('通知して' / 'remind me' / 'tell me when …') or when reporting completion of a long-running task / monitoring summary / scheduled reminder firing. " +
      "This is the canonical built-in notification path: it reaches the web bell, and on macOS the Reminders sink as well (on by default — the user may have silenced it with `--disable-macos-reminders`, `DISABLE_MACOS_REMINDER_NOTIFICATIONS=1`, or the Settings toggle). It does NOT reach messaging bridges. It has NO active-user suppression — if the user asks for a notification, fire one. " +
      "After firing, briefly tell the user you sent the notification.",

    async handler(args: Record<string, unknown>, ctx?: McpToolContext): Promise<string> {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) return "notify: `title` is required (non-empty string).";
      const bodyRaw = typeof args.body === "string" ? args.body.trim() : "";
      const body = bodyRaw.length > 0 ? bodyRaw : undefined;

      const action = buildNavigateAction(ctx);
      deps.publish({
        kind: NOTIFICATION_KINDS.push,
        title,
        body,
        ...(action ? { action } : {}),
      });
      return body ? `Notification sent: ${title}\n${body}` : `Notification sent: ${title}`;
    },
  };
}

export const notify = makeNotifyTool({ publish: publishNotification });
