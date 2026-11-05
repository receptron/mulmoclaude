// Entry point for `mulmoclaude token …` / `yarn token …`. Writes straight to
// the terminal: the issued token must reach the user verbatim, once.
import { randomBytes } from "node:crypto";
import { runClientTokenCommand } from "./clientTokenCommands.js";
import { clientTokensPath } from "./clientTokenStore.js";

process.exitCode = runClientTokenCommand(process.argv.slice(2), {
  storePath: clientTokensPath(),
  nowIso: () => new Date().toISOString(),
  randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  print: (line) => process.stdout.write(`${line}\n`),
  printError: (line) => process.stderr.write(`${line}\n`),
});
