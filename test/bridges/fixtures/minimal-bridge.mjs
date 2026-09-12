// A bridge whose only work is the client, so the process lives exactly as long
// as the client gives it something to wait on. Spawned by
// `test_bridgeFollowsRestart.ts` to check that waiting for a port actually
// waits — inside node:test the runner holds the loop open and hides this.
import { createBridgeClient } from "@mulmobridge/client";

const client = createBridgeClient({ transportId: "cli", options: {} });
process.on("SIGTERM", () => {
  client.close();
  process.exit(0);
});
