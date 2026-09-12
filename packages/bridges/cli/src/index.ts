#!/usr/bin/env node
import "dotenv/config";
import * as readline from "readline";
import { createBridgeClient } from "@mulmobridge/client";

const TRANSPORT_ID = "cli";
const CHAT_ID = "terminal";

async function main(): Promise<void> {
  console.log("MulmoClaude CLI bridge");
  console.log("Type /help for commands, Ctrl+C to exit.\n");
  // The address itself is printed by `createBridgeClient` now, for every
  // bridge rather than this one (#3085).

  const client = createBridgeClient({ transportId: TRANSPORT_ID });

  // Server → bridge async push (Phase B of #268). For Telegram this
  // would call sendMessage; the CLI just prints so the operator can
  // see scheduled / event-driven pushes arrive.
  client.onPush((ev) => {
    console.log(`\n[push] ${ev.chatId}: ${ev.message}\n`);
  });

  // Streaming text chunks (Phase C of #268). Each chunk is a
  // fragment of the assistant's response, printed in real time
  // so the user sees a typing effect instead of waiting for the
  // full response.
  let streamingActive = false;
  client.onTextChunk((chunk) => {
    if (!streamingActive) {
      process.stdout.write("\nAssistant: ");
      streamingActive = true;
    }
    process.stdout.write(chunk);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const askOnce = (): Promise<string> => new Promise((resolve) => rl.question("You: ", resolve));

  for (;;) {
    const line = (await askOnce()).trim();
    if (!line) continue;

    streamingActive = false;
    const ack = await client.send(CHAT_ID, line);
    if (streamingActive) {
      // Text was streamed chunk-by-chunk; just add a trailing newline.
      process.stdout.write("\n\n");
    } else if (ack.ok) {
      // No chunks arrived (e.g. short response) — print the full ack.
      console.log(`\nAssistant: ${ack.reply ?? ""}\n`);
    } else {
      const statusSuffix = ack.status ? ` (${ack.status})` : "";
      const reason = ack.error ?? "unknown";
      console.error(`\nError${statusSuffix}: ${reason}\n`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
