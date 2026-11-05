// Named client tokens (#3618): the pure rule, the store on disk, the CLI
// commands, and the bearer check every host surface shares.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  addClientToken,
  clientTokenId,
  hashClientToken,
  isClientTokenName,
  parseClientTokenStore,
  resolvePrincipal,
  revokeClientToken,
  serializeClientTokenStore,
  type ClientTokenRecord,
} from "../../server/api/auth/clientTokenRule.js";
import { clientTokensPath, createClientTokenSource, readClientTokenFile, writeClientTokenFile } from "../../server/api/auth/clientTokenStore.js";
import { runClientTokenCommand, type ClientTokenCommandDeps } from "../../server/api/auth/clientTokenCommands.js";
import { isAuthorizedBearer, resolveTokenPrincipal } from "../../server/api/auth/principal.js";
import { isOwnerOnlyApiPath } from "../../server/api/auth/clientTokenAccess.js";
import { bearerAuth } from "../../server/api/auth/bearerAuth.js";
import { API_ROUTES } from "../../src/config/apiRoutes.js";
import type { Request, Response, NextFunction } from "express";
import { __resetForTests, generateAndWriteToken } from "../../server/api/auth/token.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { isolateHome } from "../helpers/isolatedHome.js";

const OWNER = "o".repeat(64);
const NOW = "2026-11-04T00:00:00.000Z";
const realRandomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

function issue(records: readonly ClientTokenRecord[], name: string): { records: ClientTokenRecord[]; token: string } {
  const result = addClientToken(records, { name, nowIso: NOW, randomHex: realRandomHex });
  if (!result.ok) throw new Error(`could not issue ${name}: ${result.reason}`);
  return { records: result.records, token: result.token };
}

describe("isClientTokenName", () => {
  ["a", "discord-main", "n8n.flow_1", "A".repeat(64), "9lives"].forEach((name) => {
    it(`accepts ${JSON.stringify(name)}`, () => assert.equal(isClientTokenName(name), true));
  });
  ["", "-lead", ".hidden", "_x", "a b", "a/b", "名前", "A".repeat(65), "a\n", "a=b"].forEach((name) => {
    it(`refuses ${JSON.stringify(name)}`, () => assert.equal(isClientTokenName(name), false));
  });
});

describe("addClientToken", () => {
  it("issues a token in the client format whose hash is what it stores", () => {
    const { records, token } = issue([], "bridge");
    assert.match(token, /^mct_[0-9a-f]{16}_[0-9a-f]{64}$/);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.sha256, hashClientToken(token));
    assert.equal(records[0]?.id, clientTokenId(token));
    assert.deepEqual(records[0]?.scopes, ["full"]);
    assert.equal(records[0]?.createdAt, NOW);
    assert.equal(JSON.stringify(records).includes(token), false, "the token itself is never stored");
  });

  it("refuses a duplicate name and an invalid one", () => {
    const { records } = issue([], "bridge");
    assert.deepEqual(addClientToken(records, { name: "bridge", nowIso: NOW, randomHex: realRandomHex }), { ok: false, reason: "duplicate-name" });
    assert.deepEqual(addClientToken(records, { name: "a b", nowIso: NOW, randomHex: realRandomHex }), { ok: false, reason: "invalid-name" });
  });
});

describe("revokeClientToken", () => {
  it("removes only the named token", () => {
    const first = issue([], "one");
    const second = issue(first.records, "two");
    assert.deepEqual(
      revokeClientToken(second.records, "one")?.map((record) => record.name),
      ["two"],
    );
  });

  it("returns null for a name that is not there", () => {
    assert.equal(revokeClientToken(issue([], "one").records, "two"), null);
  });
});

describe("resolvePrincipal", () => {
  const issued = issue(issue([], "one").records, "two");
  const { records } = issued;
  const tokenOne = issue([], "x").token;
  const lookups: string[] = [];
  const source = (): readonly ClientTokenRecord[] => {
    lookups.push("read");
    return records;
  };

  beforeEach(() => {
    lookups.length = 0;
  });

  it("the owner token is the owner, without reading the store", () => {
    assert.deepEqual(resolvePrincipal(OWNER, OWNER, source), { kind: "owner" });
    assert.equal(lookups.length, 0);
  });

  it("a stored client token is that client", () => {
    const principal = resolvePrincipal(issued.token, OWNER, source);
    assert.deepEqual(principal, { kind: "client", id: records[1]?.id, name: "two", scopes: ["full"] });
  });

  it("a non-client-format wrong token is refused without reading the store", () => {
    assert.equal(resolvePrincipal("wrong", OWNER, source), null);
    assert.equal(lookups.length, 0);
  });

  const refused: [string, unknown][] = [
    ["a well-formed token that was never issued", tokenOne],
    ["an issued id with another secret", issued.token.replace(/_[0-9a-f]{64}$/, `_${"0".repeat(64)}`)],
    ["the token in upper case", issued.token.toUpperCase()],
    ["the token with a trailing newline", `${issued.token}\n`],
    ["the token one character short", issued.token.slice(0, -1)],
    ["the stored hash itself", records[1]?.sha256],
    ["the prefix alone", "mct_"],
    ["a number", 42],
    ["undefined", undefined],
  ];
  refused.forEach(([label, provided]) => {
    it(`refuses ${label}`, () => assert.equal(resolvePrincipal(provided, OWNER, source), null));
  });

  it("refuses everything, client tokens included, before the owner token exists", () => {
    assert.equal(resolvePrincipal(issued.token, null, source), null);
    assert.equal(resolvePrincipal(issued.token, "", source), null);
    assert.equal(resolvePrincipal("", "", source), null);
  });

  it("a revoked token is refused while the others still pass", () => {
    const remaining = revokeClientToken(records, "two") ?? [];
    assert.equal(
      resolvePrincipal(issued.token, OWNER, () => remaining),
      null,
    );
    const one = issue([], "solo");
    assert.equal(resolvePrincipal(one.token, OWNER, () => one.records)?.kind, "client");
  });
});

describe("parseClientTokenStore", () => {
  it("round-trips what serializeClientTokenStore wrote", () => {
    const { records } = issue([], "bridge");
    assert.deepEqual(parseClientTokenStore(JSON.parse(serializeClientTokenStore(records))), { records, droppedCount: 0 });
  });

  it("drops invalid entries and keeps the valid ones", () => {
    const { records } = issue([], "bridge");
    const [valid] = records;
    const raw = {
      version: 1,
      tokens: [valid, { ...valid, sha256: "short" }, { ...valid, scopes: ["admin"] }, { ...valid, scopes: [] }, { ...valid, name: "a b" }, null, "x"],
    };
    assert.deepEqual(parseClientTokenStore(raw), { records, droppedCount: 6 });
  });

  [null, [], {}, { version: 2, tokens: [] }, { version: 1 }, { version: 1, tokens: {} }].forEach((raw) => {
    it(`throws on a file that is not a store: ${JSON.stringify(raw)}`, () => {
      assert.throws(() => parseClientTokenStore(raw));
    });
  });
});

describe("the store on disk", () => {
  const paths = { storePath: "" };
  beforeEach(() => {
    paths.storePath = path.join(makeTempDir("mulmo-client-tokens-"), ".mulmoclaude", "client-tokens.json");
  });

  it("lives under <home>/.mulmoclaude, outside the workspace", () => {
    assert.equal(clientTokensPath("/h"), path.join("/h", ".mulmoclaude", "client-tokens.json"));
  });

  it("a missing file is an empty store", () => {
    assert.deepEqual(readClientTokenFile(paths.storePath), { records: [], droppedCount: 0 });
  });

  it("is written owner-only and read back", { skip: process.platform === "win32" }, () => {
    const { records } = issue([], "bridge");
    writeClientTokenFile(paths.storePath, records);
    assert.equal(statSync(paths.storePath).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(paths.storePath)).mode & 0o777, 0o700);
    assert.deepEqual(readClientTokenFile(paths.storePath).records, records);
  });

  it("an unparsable file throws with its path", () => {
    mkdirSync(path.dirname(paths.storePath), { recursive: true });
    writeFileSync(paths.storePath, "{not json");
    assert.throws(
      () => readClientTokenFile(paths.storePath),
      (err: Error) => err.message.startsWith(paths.storePath),
    );
  });

  it("an oversized file throws rather than being read whole", () => {
    mkdirSync(path.dirname(paths.storePath), { recursive: true });
    writeFileSync(paths.storePath, " ".repeat(1024 * 1024 + 1));
    assert.throws(() => readClientTokenFile(paths.storePath), /larger than/);
  });

  it("the server's source follows every change to the file, and fails closed on a broken one", () => {
    const source = createClientTokenSource(paths.storePath);
    assert.deepEqual(source(), []);
    const first = issue([], "one");
    writeClientTokenFile(paths.storePath, first.records);
    assert.deepEqual(source(), first.records);
    const second = issue(first.records, "two");
    writeClientTokenFile(paths.storePath, second.records);
    assert.deepEqual(source(), second.records);
    writeFileSync(paths.storePath, "{broken");
    assert.deepEqual(source(), []);
    writeClientTokenFile(paths.storePath, first.records);
    assert.deepEqual(source(), first.records);
  });
});

function commandHarness(storePath: string): { deps: ClientTokenCommandDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: { storePath, nowIso: () => NOW, randomHex: realRandomHex, print: (line) => out.push(line), printError: (line) => err.push(line) },
  };
}

describe("runClientTokenCommand", () => {
  const paths = { storePath: "" };
  beforeEach(() => {
    paths.storePath = path.join(makeTempDir("mulmo-client-token-cli-"), ".mulmoclaude", "client-tokens.json");
  });

  it("add prints the token once and stores only its hash", () => {
    const { deps, out } = commandHarness(paths.storePath);
    assert.equal(runClientTokenCommand(["add", "bridge"], deps), 0);
    const token = out.find((line) => line.startsWith("mct_")) ?? "";
    assert.equal(clientTokenId(token) !== null, true);
    const stored = readFileSync(paths.storePath, "utf8");
    assert.equal(stored.includes(token), false);
    assert.equal(stored.includes(hashClientToken(token)), true);
  });

  it("list shows names and ids, never a token", () => {
    const add = commandHarness(paths.storePath);
    runClientTokenCommand(["add", "bridge"], add.deps);
    const token = add.out.find((line) => line.startsWith("mct_")) ?? "";
    const list = commandHarness(paths.storePath);
    assert.equal(runClientTokenCommand(["list"], list.deps), 0);
    assert.equal(list.out.length, 1);
    assert.match(list.out[0] ?? "", /^bridge\t[0-9a-f]{16}\t/);
    assert.equal(list.out.join("\n").includes(token), false);
  });

  it("revoke removes the token; revoking it again fails", () => {
    runClientTokenCommand(["add", "bridge"], commandHarness(paths.storePath).deps);
    assert.equal(runClientTokenCommand(["revoke", "bridge"], commandHarness(paths.storePath).deps), 0);
    assert.deepEqual(readClientTokenFile(paths.storePath).records, []);
    assert.equal(runClientTokenCommand(["revoke", "bridge"], commandHarness(paths.storePath).deps), 1);
  });

  it("a duplicate name fails without changing the store", () => {
    runClientTokenCommand(["add", "bridge"], commandHarness(paths.storePath).deps);
    const before = readFileSync(paths.storePath, "utf8");
    assert.equal(runClientTokenCommand(["add", "bridge"], commandHarness(paths.storePath).deps), 1);
    assert.equal(readFileSync(paths.storePath, "utf8"), before);
  });

  [[], ["add"], ["revoke"], ["list", "x"], ["add", "a", "b"], ["remove", "a"], ["add", "a b"]].forEach((args) => {
    it(`refuses ${JSON.stringify(args)} with usage, writing nothing`, () => {
      const { deps, err } = commandHarness(paths.storePath);
      assert.equal(runClientTokenCommand(args, deps), 2);
      assert.equal(err.length > 0, true);
      assert.throws(() => statSync(paths.storePath));
    });
  });

  it("does not overwrite a store it cannot read", () => {
    mkdirSync(path.dirname(paths.storePath), { recursive: true });
    writeFileSync(paths.storePath, "{broken");
    assert.equal(runClientTokenCommand(["add", "bridge"], commandHarness(paths.storePath).deps), 1);
    assert.equal(readFileSync(paths.storePath, "utf8"), "{broken");
  });
});

describe("isAuthorizedBearer — the host's shared check", () => {
  const state = { restoreHome: (): void => undefined, owner: "" };
  beforeEach(async () => {
    const home = makeTempDir("mulmo-client-token-home-");
    state.restoreHome = isolateHome(home);
    __resetForTests();
    state.owner = await generateAndWriteToken(path.join(home, ".session-token"));
  });
  afterEach(() => {
    state.restoreHome();
    __resetForTests();
  });

  it("accepts the owner token with no store at all", () => {
    assert.equal(isAuthorizedBearer(state.owner), true);
    assert.equal(isAuthorizedBearer("wrong"), false);
  });

  it("accepts a token issued by the CLI and refuses it right after revoke", () => {
    const add = commandHarness(clientTokensPath());
    runClientTokenCommand(["add", "bridge"], add.deps);
    const token = add.out.find((line) => line.startsWith("mct_")) ?? "";
    assert.deepEqual(resolveTokenPrincipal(token), { kind: "client", id: clientTokenId(token), name: "bridge", scopes: ["full"] });
    assert.equal(isAuthorizedBearer(state.owner), true);
    runClientTokenCommand(["revoke", "bridge"], commandHarness(clientTokensPath()).deps);
    assert.equal(isAuthorizedBearer(token), false);
    assert.equal(isAuthorizedBearer(state.owner), true);
  });

  it("refuses a client token before the owner token exists", () => {
    const add = commandHarness(clientTokensPath());
    runClientTokenCommand(["add", "bridge"], add.deps);
    const token = add.out.find((line) => line.startsWith("mct_")) ?? "";
    __resetForTests();
    assert.equal(isAuthorizedBearer(token), false);
  });
});

describe("isOwnerOnlyApiPath", () => {
  const ownerOnly = [
    "/config",
    "/config/settings",
    "/secrets",
    "/agent",
    "/agent/cancel",
    "/roles/manage",
    "/skills/x",
    "/scheduler/tasks",
    "/plugins/runtime/list",
    "/shutdown",
    "/internal/tool-result",
    "/mcp-tools/x",
  ];
  ownerOnly.forEach((apiPath) => {
    it(`closes ${apiPath}`, () => assert.equal(isOwnerOnlyApiPath(apiPath), true));
  });

  const spellings = ["/Config/settings", "/CONFIG", "//config", "/config/", "/con%66ig", "/%zz"];
  spellings.forEach((apiPath) => {
    it(`closes the spelling ${apiPath}`, () => assert.equal(isOwnerOnlyApiPath(apiPath), true));
  });

  const open = ["/collections/todo/records", "/transports/n8n/chats/1", "/wiki", "/sessions", "/configs", "/agents", "/secretsx", "/", ""];
  open.forEach((apiPath) => {
    it(`leaves ${JSON.stringify(apiPath)} open`, () => assert.equal(isOwnerOnlyApiPath(apiPath), false));
  });

  // Every top-level segment the app routes must be decided on purpose: a new
  // one fails here until it is added to the owner-only list or to this one.
  const CLIENT_OPEN_SEGMENTS = new Set([
    "accounting",
    "attachments",
    "canvas",
    "chart",
    "chat-index",
    "collections",
    "dashboard",
    "edit-image",
    "feeds",
    "files",
    "form",
    "generate-image",
    "google-map",
    "health",
    "html",
    "images",
    "journal",
    "kentei",
    "markdown",
    "marp-themes",
    "mindmap",
    "mulmoScript",
    "notifier",
    "pdf",
    "photoLocations",
    "presentCollection",
    "quiz",
    "sessions",
    "shapescript",
    "share",
    "spreadsheet",
    "svg",
    "transcribe",
    "translation",
    "transports",
    "wiki",
    "x",
  ]);
  const routedSegments = (value: unknown): string[] => {
    if (typeof value === "string") return value.startsWith("/api/") ? [value.split("/")[2] ?? ""] : [];
    return value !== null && typeof value === "object" ? Object.values(value).flatMap(routedSegments) : [];
  };
  it("classifies every routed /api segment", () => {
    const unclassified = [...new Set(routedSegments(API_ROUTES))].filter((segment) => !CLIENT_OPEN_SEGMENTS.has(segment) && !isOwnerOnlyApiPath(`/${segment}`));
    assert.deepEqual(unclassified, []);
  });
});

describe("bearerAuth — client tokens", () => {
  const state = { restoreHome: (): void => undefined, owner: "", client: "" };
  beforeEach(async () => {
    const home = makeTempDir("mulmo-client-token-mw-");
    state.restoreHome = isolateHome(home);
    __resetForTests();
    state.owner = await generateAndWriteToken(path.join(home, ".session-token"));
    const add = commandHarness(clientTokensPath());
    runClientTokenCommand(["add", "n8n"], add.deps);
    state.client = add.out.find((line) => line.startsWith("mct_")) ?? "";
  });
  afterEach(() => {
    state.restoreHome();
    __resetForTests();
  });

  function callMiddleware(token: string, apiPath: string): { nextCalled: boolean; statusCode: number } {
    const outcome = { nextCalled: false, statusCode: 200 };
    const res = {
      status(code: number) {
        outcome.statusCode = code;
        return res;
      },
      json() {
        return res;
      },
    };
    const next: NextFunction = () => {
      outcome.nextCalled = true;
    };
    // Only the fields the middleware reads.
    bearerAuth({ headers: { authorization: `Bearer ${token}` }, path: apiPath, method: "GET" } as unknown as Request, res as unknown as Response, next);
    return outcome;
  }

  it("passes a client token on a data path", () => {
    assert.deepEqual(callMiddleware(state.client, "/collections/todo/records"), { nextCalled: true, statusCode: 200 });
  });

  it("refuses a client token with 403 on an owner-only path", () => {
    assert.deepEqual(callMiddleware(state.client, "/config/settings"), { nextCalled: false, statusCode: 403 });
    assert.deepEqual(callMiddleware(state.client, "/Secrets"), { nextCalled: false, statusCode: 403 });
  });

  it("still lets the owner token through the owner-only paths", () => {
    assert.deepEqual(callMiddleware(state.owner, "/config/settings"), { nextCalled: true, statusCode: 200 });
  });

  it("refuses an unknown token with 401 everywhere", () => {
    assert.deepEqual(callMiddleware("mct_nope", "/collections"), { nextCalled: false, statusCode: 401 });
  });
});
