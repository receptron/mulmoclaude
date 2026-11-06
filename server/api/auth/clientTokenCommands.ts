// `mulmoclaude token add|list|revoke` (#3618). The terminal I/O, clock and
// randomness are injected so every command is testable without a terminal.

import { addClientToken, revokeClientToken, type ClientTokenRecord } from "./clientTokenRule.js";
import { FULL_SCOPE, isClientTokenScope, type ClientTokenScope } from "./clientTokenScope.js";
import { errorMessage } from "../../utils/errors.js";
import { readClientTokenFile, withClientTokenLock, writeClientTokenFile } from "./clientTokenStore.js";

export interface ClientTokenCommandDeps {
  storePath: string;
  nowIso: () => string;
  randomHex: (bytes: number) => string;
  print: (line: string) => void;
  printError: (line: string) => void;
}

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

export const CLIENT_TOKEN_USAGE = [
  "Usage: mulmoclaude token add <name> [--scope <scope>]...  issue a token (shown once)",
  "       mulmoclaude token list                             list issued tokens (never their values)",
  "       mulmoclaude token revoke <name>                    revoke a token; a running server stops accepting it at once",
  "",
  "A name is 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit.",
  "A scope is 'full' (the default: the whole client API and both sockets), or any of",
  "'read' (GET and HEAD only) and 'collection:<slug>' (that collection only; repeatable).",
  "A token with scopes other than 'full' cannot open a socket. 'full' combines with nothing.",
];

const SCOPE_FLAG = "--scope";

const ADD_REFUSALS = {
  "invalid-name": "is not a valid name",
  "duplicate-name": "is already in use; revoke it first or pick another name",
  "invalid-scopes": "cannot have 'full' together with another scope",
} as const;

/** `--scope <scope>` pairs, or null when anything else is there. */
export function parseScopeFlags(flags: readonly string[]): ClientTokenScope[] | null {
  if (flags.length % 2 !== 0) return null;
  const isFlagPosition = (index: number): boolean => index % 2 === 0;
  if (!flags.every((flag, index) => !isFlagPosition(index) || flag === SCOPE_FLAG)) return null;
  const values = flags.filter((_, index) => !isFlagPosition(index));
  return values.every(isClientTokenScope) ? values : null;
}

function addCommand(name: string, scopes: readonly ClientTokenScope[], records: readonly ClientTokenRecord[], deps: ClientTokenCommandDeps): number {
  const requested: readonly ClientTokenScope[] = scopes.length > 0 ? scopes : [FULL_SCOPE];
  const result = addClientToken(records, { name, nowIso: deps.nowIso(), randomHex: deps.randomHex, scopes: requested });
  if (!result.ok) {
    deps.printError(`"${name}" ${ADD_REFUSALS[result.reason]}.`);
    return result.reason === "duplicate-name" ? EXIT_FAILURE : EXIT_USAGE;
  }
  writeClientTokenFile(deps.storePath, result.records);
  deps.print(`Issued client token "${name}" (id ${result.record.id}, scopes ${result.record.scopes.join(",")}). It is shown only this once:`);
  deps.print("");
  deps.print(result.token);
  deps.print("");
  deps.print("Give it to that client as MULMOCLAUDE_AUTH_TOKEN, and to no other.");
  return EXIT_OK;
}

function listCommand(records: readonly ClientTokenRecord[], deps: ClientTokenCommandDeps): number {
  if (records.length === 0) deps.print("No client tokens issued.");
  records.forEach((record) => deps.print(`${record.name}\t${record.id}\t${record.createdAt}\t${record.scopes.join(",")}`));
  return EXIT_OK;
}

function revokeCommand(name: string, records: readonly ClientTokenRecord[], deps: ClientTokenCommandDeps): number {
  const remaining = revokeClientToken(records, name);
  if (remaining === null) {
    deps.printError(`No client token named "${name}".`);
    return EXIT_FAILURE;
  }
  writeClientTokenFile(deps.storePath, remaining);
  deps.print(`Revoked client token "${name}".`);
  return EXIT_OK;
}

function dispatch(args: readonly string[], records: readonly ClientTokenRecord[], deps: ClientTokenCommandDeps): number | null {
  const [command, name, ...extra] = args;
  if (command === "add" && name !== undefined) {
    const scopes = parseScopeFlags(extra);
    return scopes === null ? null : addCommand(name, scopes, records, deps);
  }
  if (extra.length > 0) return null;
  if (command === "list" && name === undefined) return listCommand(records, deps);
  if (command === "revoke" && name !== undefined) return revokeCommand(name, records, deps);
  return null;
}

function runLocked(args: readonly string[], deps: ClientTokenCommandDeps): number {
  const { records, droppedCount } = readClientTokenFile(deps.storePath);
  if (droppedCount > 0) deps.printError(`${deps.storePath}: ${droppedCount} invalid entries are ignored and will be dropped on the next change.`);
  const exitCode = dispatch(args, records, deps);
  if (exitCode !== null) return exitCode;
  CLIENT_TOKEN_USAGE.forEach((line) => deps.printError(line));
  return EXIT_USAGE;
}

export function runClientTokenCommand(args: readonly string[], deps: ClientTokenCommandDeps): number {
  try {
    return withClientTokenLock(deps.storePath, () => runLocked(args, deps));
  } catch (err) {
    deps.printError(errorMessage(err));
    return EXIT_FAILURE;
  }
}
