// A bridge whose only work is the client, so the process lives exactly as long
// as the client gives it something to wait on. Spawned by
// `test_bridgeFollowsRestart.ts` because these are the two properties node:test
// cannot see: inside the runner the loop is held open regardless.
//
//   (no argument)  — create the client and let it hold the process
//   close          — create it, close it, and let the process end if it can
import { createBridgeClient } from "@mulmobridge/client";

const client = createBridgeClient({ transportId: "cli", options: {} });
if (process.argv[2] === "close") client.close();
process.on("SIGTERM", () => {
  client.close();
  process.exit(0);
});
